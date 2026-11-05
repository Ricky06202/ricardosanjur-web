from __future__ import annotations

import asyncio
import csv
import fcntl
import io
import json
import logging
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unicodedata
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Annotated, Any

from fastapi import FastAPI, File, Form, Header, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask


LOGGER = logging.getLogger("cad_converter")
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MAX_UPLOAD_BYTES = int(os.environ.get("CAD_MAX_UPLOAD_BYTES", "90000000"))
MAX_PUBLIC_UPLOAD_BYTES = 25_000_000
MAX_OUTPUT_BYTES = int(os.environ.get("CAD_MAX_OUTPUT_BYTES", "90000000"))
MAX_PDF_PAGES = int(os.environ.get("CAD_MAX_PDF_PAGES", "40"))
MAX_ARCHIVE_ENTRIES = 200
MAX_ARCHIVE_UNPACKED_BYTES = 250_000_000
MAX_ARCHIVE_RATIO = 200
MAX_DPI = 300
MIN_DPI = 150

PROJECT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
LAYER_ID_RE = re.compile(r"^[0-9a-f]{32}$")
ACTOR_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
ALLOWED_CRS = {"EPSG:4326", "EPSG:32617", "EPSG:26717"}
AUDIT_FIELDS = (
    "created_at",
    "project_id",
    "operation",
    "filename",
    "actor",
    "input_bytes",
    "output_format",
    "output_bytes",
    "status",
    "error_code",
)
GIS_EXTENSIONS = {".dwg", ".dxf", ".zip", ".kml", ".geojson", ".gpkg"}
MEDIA_EXTENSIONS = GIS_EXTENSIONS | {".pdf"}
MEDIA_FORMATS = {"pdf", "jpg", "png", "svg", "kml", "geojson"}
VECTOR_FORMATS = {"kml", "geojson"}
SHAPEFILE_COMPANIONS = {".shp", ".shx", ".dbf", ".prj", ".cpg", ".qix", ".sbn", ".sbx"}
CONVERSION_LOCK = asyncio.Semaphore(1)

app = FastAPI(
    title="RS CAD/GIS and document converter",
    description="Private conversion service for the Ricardo Sanjur map viewer.",
    docs_url="/docs",
    redoc_url=None,
)


class ServiceError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        self.status_code = status_code
        self.code = code
        self.message = message
        super().__init__(message)


@app.exception_handler(ServiceError)
async def service_error_handler(_request: Any, exc: ServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message}},
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


def validate_project_id(value: str) -> str:
    project_id = value.strip().lower()
    if not PROJECT_ID_RE.fullmatch(project_id):
        raise ServiceError(400, "INVALID_PROJECT", "El proyecto indicado no es válido.")
    return project_id


def validate_layer_id(value: str) -> str:
    layer_id = value.strip().lower()
    if not LAYER_ID_RE.fullmatch(layer_id):
        raise ServiceError(404, "LAYER_NOT_FOUND", "No se encontró esa capa.")
    return layer_id


def validate_source_crs(value: str) -> str:
    crs = value.strip().upper()
    if crs.lower() == "auto":
        return "auto"
    if crs not in ALLOWED_CRS:
        raise ServiceError(400, "INVALID_CRS", "Seleccione Auto, EPSG:4326, EPSG:32617 o EPSG:26717.")
    return crs


def validate_color(value: str) -> str:
    color = value.strip().lower()
    if not re.fullmatch(r"#[0-9a-f]{6}", color):
        raise ServiceError(400, "INVALID_COLOR", "El color seleccionado no es válido.")
    return color


def safe_filename(value: str | None) -> str:
    raw = (value or "").replace("\\", "/").split("/")[-1]
    raw = unicodedata.normalize("NFKC", raw)
    cleaned = re.sub(r"[^\w.()-]+", "_", raw, flags=re.UNICODE).strip(" .")[:120]
    if not cleaned or cleaned in {".", ".."}:
        return "archivo"
    return cleaned


def safe_stem(value: str) -> str:
    stem = Path(safe_filename(value)).stem
    ascii_stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode("ascii")
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", ascii_stem).strip("_-.")[:64]
    return cleaned or "plano"


def project_directory(root: Path, project_id: str) -> Path:
    project = validate_project_id(project_id)
    base = root.resolve()
    directory = (base / project).resolve()
    if not directory.is_relative_to(base):
        raise ServiceError(400, "INVALID_PROJECT", "El proyecto indicado no es válido.")
    directory.mkdir(parents=True, exist_ok=True, mode=0o750)
    return directory


def storage_directories() -> tuple[Path, Path, Path, Path]:
    originals = DATA_DIR / "originales"
    geojson = DATA_DIR / "geojson"
    exports = DATA_DIR / "exportados"
    logs = DATA_DIR / "logs"
    for directory in (originals, geojson, exports, logs):
        directory.mkdir(parents=True, exist_ok=True, mode=0o750)
    return originals, geojson, exports, logs


def record_event(
    *,
    project_id: str,
    operation: str,
    filename: str,
    actor: str | None,
    input_bytes: int,
    status: str,
    output_format: str | None = None,
    output_bytes: int | None = None,
    error_code: str | None = None,
) -> None:
    _, _, _, logs = storage_directories()
    event = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "project_id": project_id,
        "operation": operation,
        "filename": filename,
        "actor": actor if actor and ACTOR_RE.fullmatch(actor) else "admin",
        "input_bytes": input_bytes,
        "output_format": output_format,
        "output_bytes": output_bytes,
        "status": status,
        "error_code": error_code,
    }
    path = logs / "historial_subidas.csv"
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=AUDIT_FIELDS, lineterminator="\n")
    descriptor = os.open(
        path,
        os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0),
        0o640,
    )
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        if os.fstat(descriptor).st_size == 0:
            writer.writeheader()
        writer.writerow(event)
        data = buffer.getvalue().encode("utf-8")
        while data:
            written = os.write(descriptor, data)
            if written <= 0:
                raise OSError("No se pudo completar la escritura del registro de auditoría.")
            data = data[written:]
        os.fsync(descriptor)
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


async def store_upload(file: UploadFile, project_id: str) -> tuple[Path, str, int]:
    original_name = safe_filename(file.filename)
    destination = project_directory(storage_directories()[0], project_id)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stored_path = destination / f"{timestamp}_{project_id}_{uuid.uuid4().hex}_{original_name}"
    total = 0
    try:
        with stored_path.open("xb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise ServiceError(413, "FILE_TOO_LARGE", "El archivo supera el límite de 90 MB.")
                await asyncio.to_thread(output.write, chunk)
        if total == 0:
            raise ServiceError(400, "EMPTY_FILE", "El archivo está vacío.")
    except Exception:
        stored_path.unlink(missing_ok=True)
        raise
    return stored_path, original_name, total


def _run_command(
    args: list[str],
    timeout_seconds: int,
    capture_stdout: bool = False,
    stdout_path: Path | None = None,
) -> str:
    try:
        if stdout_path is None:
            result = subprocess.run(
                args,
                check=False,
                stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout_seconds,
            )
        else:
            with stdout_path.open("wb") as output_file:
                result = subprocess.run(
                    args,
                    check=False,
                    stdout=output_file,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=timeout_seconds,
                )
    except FileNotFoundError as exc:
        raise ServiceError(503, "CONVERTER_UNAVAILABLE", "Falta una herramienta de conversión del servicio.") from exc
    except subprocess.TimeoutExpired as exc:
        raise ServiceError(422, "CONVERSION_TIMEOUT", "La conversión tardó demasiado; pruebe con un archivo más pequeño.") from exc
    if result.returncode != 0:
        LOGGER.warning("conversion tool failed: %s exit=%s", Path(args[0]).name, result.returncode)
        raise ServiceError(422, "CONVERSION_FAILED", "No se pudo convertir el archivo. Verifique el archivo y su sistema de coordenadas.")
    return result.stdout or ""


async def store_temporary_upload(
    file: UploadFile,
    temporary_directory: Path,
    max_bytes: int = MAX_PUBLIC_UPLOAD_BYTES,
) -> tuple[Path, str, int]:
    filename = safe_filename(file.filename)
    suffix = Path(filename).suffix.lower()
    path = temporary_directory / f"upload-{uuid.uuid4().hex}{suffix}"
    total = 0
    try:
        with path.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > max_bytes:
                    raise ServiceError(
                        413,
                        "PUBLIC_UPLOAD_TOO_LARGE",
                        f"Los archivos públicos no pueden superar {max_bytes // 1_000_000} MB.",
                    )
                output.write(chunk)
    except Exception:
        await asyncio.to_thread(path.unlink, missing_ok=True)
        raise
    if total == 0:
        raise ServiceError(400, "EMPTY_FILE", "El archivo está vacío.")
    return path, filename, total


async def run_command(
    args: list[str],
    timeout_seconds: int = 180,
    capture_stdout: bool = False,
    stdout_path: Path | None = None,
) -> str:
    return await asyncio.to_thread(_run_command, args, timeout_seconds, capture_stdout, stdout_path)


def safe_extract_shapefile(zip_path: Path, destination: Path) -> Path:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    try:
        archive = zipfile.ZipFile(zip_path)
    except (OSError, zipfile.BadZipFile) as exc:
        raise ServiceError(400, "INVALID_ARCHIVE", "El ZIP no es válido.") from exc

    with archive:
        entries = archive.infolist()
        if len(entries) > MAX_ARCHIVE_ENTRIES:
            raise ServiceError(413, "ARCHIVE_TOO_MANY_FILES", "El ZIP contiene demasiados archivos.")
        total_size = 0
        files: list[tuple[zipfile.ZipInfo, PurePosixPath]] = []
        for entry in entries:
            normalized = entry.filename.replace("\\", "/")
            path = PurePosixPath(normalized)
            if path.is_absolute() or not path.parts or any(part in {"..", "."} for part in path.parts) or ":" in path.parts[0]:
                raise ServiceError(400, "UNSAFE_ARCHIVE", "El ZIP contiene una ruta no permitida.")
            file_type = stat.S_IFMT(entry.external_attr >> 16)
            if file_type == stat.S_IFLNK:
                raise ServiceError(400, "UNSAFE_ARCHIVE", "El ZIP contiene un enlace no permitido.")
            if entry.is_dir():
                continue
            total_size += entry.file_size
            if total_size > MAX_ARCHIVE_UNPACKED_BYTES:
                raise ServiceError(413, "ARCHIVE_TOO_LARGE", "El contenido descomprimido del ZIP es demasiado grande.")
            if entry.file_size > 1_000_000 and (entry.compress_size == 0 or entry.file_size / entry.compress_size > MAX_ARCHIVE_RATIO):
                raise ServiceError(413, "ARCHIVE_RATIO_TOO_LARGE", "El ZIP tiene una relación de compresión no permitida.")
            files.append((entry, path))

        shapefiles = [(entry, path) for entry, path in files if path.suffix.lower() == ".shp"]
        if len(shapefiles) != 1:
            raise ServiceError(400, "SHAPEFILE_NOT_FOUND", "El ZIP debe contener exactamente un archivo .shp.")
        shp_entry, shp_path = shapefiles[0]
        stem = shp_path.stem.casefold()
        parent = shp_path.parent
        selected = [
            (entry, path)
            for entry, path in files
            if path.parent == parent
            and path.stem.casefold() == stem
            and path.suffix.lower() in SHAPEFILE_COMPANIONS
        ]
        selected_extensions = {path.suffix.lower() for _, path in selected}
        if not {".shp", ".shx", ".dbf"}.issubset(selected_extensions):
            raise ServiceError(400, "SHAPEFILE_INCOMPLETE", "El ZIP debe incluir .shp, .shx y .dbf del mismo nombre.")

        for entry, relative_path in selected:
            target = (destination / Path(*relative_path.parts)).resolve()
            if not target.is_relative_to(root):
                raise ServiceError(400, "UNSAFE_ARCHIVE", "El ZIP contiene una ruta no permitida.")
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                with archive.open(entry) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
            except (OSError, zipfile.BadZipFile) as exc:
                raise ServiceError(400, "INVALID_ARCHIVE", "No se pudo leer el shapefile del ZIP.") from exc
        return (destination / Path(*shp_path.parts)).resolve()


async def prepare_vector_input(source: Path, original_name: str, work_dir: Path) -> tuple[Path, str, bool]:
    extension = Path(original_name).suffix.lower()
    has_projection_file = False
    if extension == ".zip":
        source = await asyncio.to_thread(safe_extract_shapefile, source, work_dir / "shapefile")
        extension = ".shp"
        has_projection_file = source.with_suffix(".prj").is_file() or source.with_suffix(".PRJ").is_file()
    elif extension == ".shp":
        has_projection_file = source.with_suffix(".prj").is_file() or source.with_suffix(".PRJ").is_file()
    elif extension == ".dwg":
        dxf = work_dir / f"{uuid.uuid4().hex}.dxf"
        await run_command(["dwg2dxf", "-y", "-o", str(dxf), str(source)], timeout_seconds=240)
        if not dxf.is_file() or dxf.stat().st_size == 0:
            raise ServiceError(422, "DWG_CONVERSION_FAILED", "No se pudo leer este DWG con LibreDWG.")
        if dxf.stat().st_size > MAX_OUTPUT_BYTES:
            raise ServiceError(413, "OUTPUT_TOO_LARGE", "El DXF temporal generado supera el límite de 90 MB.")
        source = dxf
        extension = ".dxf"
    return source, extension, has_projection_file


def require_source_crs(source_crs: str, extension: str, has_projection_file: bool) -> None:
    if source_crs != "auto":
        return
    if extension in {".dxf", ".dwg"} or (extension == ".shp" and not has_projection_file):
        raise ServiceError(400, "SOURCE_CRS_REQUIRED", "Este archivo no identifica su sistema de coordenadas. Selecciónelo antes de convertir.")


async def export_vector(
    source: Path,
    original_name: str,
    source_crs: str,
    target_format: str,
    output_path: Path,
    work_dir: Path,
) -> tuple[str, bool]:
    vector_source, extension, has_projection_file = await prepare_vector_input(source, original_name, work_dir)
    require_source_crs(source_crs, extension, has_projection_file)
    if extension not in {".dxf", ".shp", ".kml", ".geojson", ".gpkg"}:
        raise ServiceError(400, "UNSUPPORTED_VECTOR_FILE", "Ese formato no contiene una capa vectorial compatible.")

    driver = "GeoJSON" if target_format == "geojson" else "KML"
    args = ["ogr2ogr", "-f", driver]
    if extension == ".dxf":
        # CAD drawings may contain entities that GeoJSON cannot represent, such as 3D solids.
        # Preserve supported vector geometries instead of failing the whole export.
        args.append("-skipfailures")
    if source_crs != "auto":
        args.extend(["-s_srs", source_crs])
    args.extend(["-t_srs", "EPSG:4326"])
    if driver == "GeoJSON":
        args.extend(["-lco", "RFC7946=YES"])
    args.extend([str(output_path), str(vector_source)])
    await run_command(args, timeout_seconds=240)
    if not output_path.is_file() or output_path.stat().st_size == 0:
        raise ServiceError(422, "EMPTY_CONVERSION", "La conversión no generó geometrías.")
    if output_path.stat().st_size > MAX_OUTPUT_BYTES:
        raise ServiceError(413, "OUTPUT_TOO_LARGE", "El archivo convertido supera el límite de salida de 90 MB.")
    if driver == "GeoJSON" and feature_count(output_path) == 0:
        raise ServiceError(422, "EMPTY_CONVERSION", "La conversión no generó geometrías vectoriales compatibles.")
    return extension, has_projection_file


def feature_count(path: Path) -> int:
    try:
        with path.open("r", encoding="utf-8") as source:
            data = json.load(source)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ServiceError(422, "INVALID_GEOJSON", "La conversión no produjo un GeoJSON válido.") from exc
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        raise ServiceError(422, "INVALID_GEOJSON", "La conversión no produjo una colección GeoJSON válida.")
    return len(data["features"])


def persist_metadata(directory: Path, layer_id: str, metadata: dict[str, Any]) -> None:
    target = directory / f"{layer_id}.meta.json"
    temporary = directory / f".{layer_id}.meta.tmp"
    temporary.write_text(json.dumps(metadata, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, target)


def file_response(path: Path, filename: str | None, media_type: str, headers: dict[str, str] | None = None) -> FileResponse:
    response_headers = {"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"}
    if headers:
        response_headers.update(headers)
    return FileResponse(path=path, filename=filename, media_type=media_type, headers=response_headers)


def temporary_file_response(
    path: Path,
    filename: str | None,
    media_type: str,
    temporary_directory: Path,
    headers: dict[str, str] | None = None,
) -> FileResponse:
    response_headers = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
    if headers:
        response_headers.update(headers)
    return FileResponse(
        path=path,
        filename=filename,
        media_type=media_type,
        headers=response_headers,
        background=BackgroundTask(shutil.rmtree, temporary_directory, ignore_errors=True),
    )


def media_type_for(extension: str) -> str:
    return {
        ".geojson": "application/geo+json",
        ".kml": "application/vnd.google-earth.kml+xml",
        ".pdf": "application/pdf",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".zip": "application/zip",
    }.get(extension.lower(), "application/octet-stream")


def validate_conversion_pair(extension: str, target_format: str) -> str:
    target = target_format.strip().lower()
    if extension == ".shp":
        raise ServiceError(
            400,
            "SHAPEFILE_ZIP_REQUIRED",
            "Suba el shapefile como ZIP con sus archivos .shp, .shx, .dbf y el .prj si existe.",
        )
    if target == "jpeg":
        target = "jpg"
    if target not in MEDIA_FORMATS:
        raise ServiceError(400, "INVALID_TARGET_FORMAT", "El formato de salida solicitado no es compatible.")
    if extension not in MEDIA_EXTENSIONS:
        raise ServiceError(400, "UNSUPPORTED_FILE", "El formato de archivo seleccionado no es compatible.")
    if extension == ".pdf" and target not in {"jpg", "png"}:
        raise ServiceError(400, "INVALID_CONVERSION", "Los PDF se pueden convertir a JPG o PNG.")
    if extension in {".dwg", ".dxf"} and target not in {"pdf", "jpg", "png", "svg", "kml", "geojson"}:
        raise ServiceError(400, "INVALID_CONVERSION", "Ese formato de salida no se admite para planos CAD.")
    if extension in {".shp", ".zip", ".kml", ".geojson", ".gpkg"} and target not in VECTOR_FORMATS:
        raise ServiceError(400, "INVALID_CONVERSION", "Los archivos GIS se pueden exportar a GeoJSON o KML.")
    return target


async def render_cad(
    source: Path,
    original_name: str,
    target_format: str,
    dpi: int,
    work_dir: Path,
) -> tuple[Path, str, str]:
    render_source = source
    if Path(original_name).suffix.lower() == ".dxf":
        render_source = work_dir / f"{uuid.uuid4().hex}.dwg"
        await run_command(
            ["dxf2dwg", "-y", "-o", str(render_source), str(source)],
            timeout_seconds=240,
        )

    svg = work_dir / f"{uuid.uuid4().hex}.svg"
    await run_command(["dwg2svg", str(render_source)], timeout_seconds=240, stdout_path=svg)
    if not svg.is_file() or svg.stat().st_size == 0:
        raise ServiceError(422, "CAD_RENDER_FAILED", "LibreDWG no pudo dibujar este archivo CAD.")
    if svg.stat().st_size > MAX_OUTPUT_BYTES:
        raise ServiceError(413, "OUTPUT_TOO_LARGE", "El SVG generado supera el límite de 90 MB.")

    if target_format == "svg":
        return svg, safe_filename(f"{safe_stem(original_name)}.svg"), "image/svg+xml"

    if target_format == "pdf":
        pdf = work_dir / f"{uuid.uuid4().hex}.pdf"
        await run_command(["rsvg-convert", "-f", "pdf", "-o", str(pdf), str(svg)], timeout_seconds=180)
        if pdf.stat().st_size > MAX_OUTPUT_BYTES:
            raise ServiceError(413, "OUTPUT_TOO_LARGE", "El PDF generado supera el límite de 90 MB.")
        return pdf, safe_filename(f"{safe_stem(original_name)}.pdf"), "application/pdf"

    if target_format == "png":
        png = work_dir / f"{uuid.uuid4().hex}.png"
        await run_command(["rsvg-convert", "-f", "png", "-d", str(dpi), "-p", str(dpi), "-o", str(png), str(svg)], timeout_seconds=180)
        if png.stat().st_size > MAX_OUTPUT_BYTES:
            raise ServiceError(413, "OUTPUT_TOO_LARGE", "El PNG generado supera el límite de 90 MB.")
        return png, safe_filename(f"{safe_stem(original_name)}.png"), "image/png"

    pdf = work_dir / f"{uuid.uuid4().hex}.pdf"
    await run_command(["rsvg-convert", "-f", "pdf", "-o", str(pdf), str(svg)], timeout_seconds=180)
    if pdf.stat().st_size > MAX_OUTPUT_BYTES:
        raise ServiceError(413, "OUTPUT_TOO_LARGE", "El PDF intermedio supera el límite de 90 MB.")
    prefix = work_dir / f"{uuid.uuid4().hex}_render"
    await run_command(["pdftoppm", "-jpeg", "-r", str(dpi), "-singlefile", str(pdf), str(prefix)], timeout_seconds=180)
    jpg = prefix.with_suffix(".jpg")
    if not jpg.exists():
        jpg = prefix.with_suffix(".jpeg")
    if not jpg.is_file():
        raise ServiceError(422, "CAD_RENDER_FAILED", "No se pudo generar la imagen JPG del plano.")
    return jpg, safe_filename(f"{safe_stem(original_name)}.jpg"), "image/jpeg"


def pdf_page_count(pdf_path: Path) -> int:
    try:
        info = subprocess.run(["pdfinfo", str(pdf_path)], capture_output=True, text=True, timeout=30, check=False)
    except FileNotFoundError as exc:
        raise ServiceError(503, "CONVERTER_UNAVAILABLE", "Falta una herramienta de conversión del servicio.") from exc
    except subprocess.TimeoutExpired as exc:
        raise ServiceError(422, "PDF_INSPECTION_TIMEOUT", "No se pudo revisar el PDF dentro del tiempo permitido.") from exc
    if info.returncode != 0:
        raise ServiceError(400, "INVALID_PDF", "El PDF está dañado, protegido o no se puede leer.")
    match = re.search(r"^Pages:\s+(\d+)\s*$", info.stdout, flags=re.MULTILINE)
    if not match:
        raise ServiceError(400, "INVALID_PDF", "No se pudo determinar el número de páginas del PDF.")
    pages = int(match.group(1))
    if pages < 1 or pages > MAX_PDF_PAGES:
        raise ServiceError(413, "PDF_PAGE_LIMIT", f"El límite es de {MAX_PDF_PAGES} páginas por conversión.")
    return pages


async def render_pdf(pdf_path: Path, original_name: str, target_format: str, dpi: int, work_dir: Path) -> tuple[Path, str, str]:
    pages = await asyncio.to_thread(pdf_page_count, pdf_path)
    prefix = work_dir / "pagina"
    args = ["pdftoppm", "-r", str(dpi), "-f", "1", "-l", str(pages)]
    args.append("-jpeg" if target_format == "jpg" else "-png")
    args.extend([str(pdf_path), str(prefix)])
    await run_command(args, timeout_seconds=240)
    suffix = "jpg" if target_format == "jpg" else "png"
    generated = sorted(work_dir.glob(f"pagina-*.{suffix}"))
    if not generated and suffix == "jpg":
        generated = sorted(work_dir.glob("pagina-*.jpeg"))
    if len(generated) != pages:
        raise ServiceError(422, "PDF_RENDER_FAILED", "No se pudieron rasterizar todas las páginas del PDF.")
    if sum(image.stat().st_size for image in generated) > MAX_OUTPUT_BYTES:
        raise ServiceError(413, "OUTPUT_TOO_LARGE", "Las imágenes generadas superan el límite de salida de 90 MB.")
    if pages == 1:
        return generated[0], safe_filename(f"{safe_stem(original_name)}.{suffix}"), media_type_for(f".{suffix}")

    if pages == 1:
        return generated[0], safe_filename(f"{safe_stem(original_name)}.{suffix}"), media_type_for(f".{suffix}")
    archive_path = work_dir / f"{uuid.uuid4().hex}_paginas.zip"
    await asyncio.to_thread(write_image_archive, archive_path, generated, original_name, suffix)
    return archive_path, safe_filename(f"{safe_stem(original_name)}_paginas.zip"), "application/zip"


def write_image_archive(archive_path: Path, images: list[Path], original_name: str, suffix: str) -> None:
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for index, image in enumerate(images, start=1):
            archive.write(image, arcname=f"{safe_stem(original_name)}-{index:03d}.{suffix}")


def persist_export(
    generated: Path,
    project_id: str,
    filename: str,
    actor: str | None,
    operation: str,
    source_bytes: int,
    output_format: str,
) -> tuple[Path, str, int]:
    if not generated.is_file():
        raise ServiceError(422, "CONVERSION_FAILED", "No se generó un archivo de salida.")
    size = generated.stat().st_size
    if size <= 0 or size > MAX_OUTPUT_BYTES:
        raise ServiceError(413, "OUTPUT_TOO_LARGE", "El archivo generado supera el límite de salida de 90 MB.")
    directory = project_directory(storage_directories()[2], project_id)
    export_id = uuid.uuid4().hex
    stored_name = f"{export_id}_{filename}"
    stored_path = directory / stored_name
    shutil.copyfile(generated, stored_path)
    record_event(
        project_id=project_id,
        operation=operation,
        filename=filename,
        actor=actor,
        input_bytes=source_bytes,
        status="ok",
        output_format=output_format,
        output_bytes=size,
    )
    return stored_path, filename, size


@app.get("/health")
async def health() -> dict[str, bool]:
    return {"ok": True}


@app.post("/api/convert")
async def convert_for_overlay(
    file: Annotated[UploadFile, File(...)],
    source_crs: Annotated[str, Form()] = "auto",
    color: Annotated[str, Form()] = "#2563eb",
    project_id: Annotated[str, Header(alias="X-Map-Project-ID")] = "",
    actor: Annotated[str | None, Header(alias="X-Admin-Email")] = None,
) -> FileResponse:
    project = validate_project_id(project_id) if project_id.strip() else None
    crs = validate_source_crs(source_crs)
    layer_color = validate_color(color)
    original_name = safe_filename(file.filename)
    extension = Path(original_name).suffix.lower()
    if extension == ".shp":
        raise ServiceError(
            400,
            "SHAPEFILE_ZIP_REQUIRED",
            "Suba el shapefile como ZIP con sus archivos .shp, .shx, .dbf y el .prj si existe.",
        )
    if extension not in GIS_EXTENSIONS:
        raise ServiceError(400, "UNSUPPORTED_FILE", "Use DWG, DXF, ZIP de Shapefile, KML, GeoJSON o GeoPackage.")

    layer_id = uuid.uuid4().hex
    temporary_directory = Path(tempfile.mkdtemp(prefix="cad-gis-", dir="/tmp"))
    input_size = 0
    cleanup_directory = True
    try:
        if project:
            stored_original, original_name, input_size = await store_upload(file, project)
        else:
            stored_original, original_name, input_size = await store_temporary_upload(file, temporary_directory)

        async with CONVERSION_LOCK:
            output = temporary_directory / f"{layer_id}.geojson"
            await export_vector(stored_original, original_name, crs, "geojson", output, temporary_directory)
            count = await asyncio.to_thread(feature_count, output)
            output_size = output.stat().st_size
            if output_size > MAX_OUTPUT_BYTES:
                raise ServiceError(413, "OUTPUT_TOO_LARGE", "El GeoJSON generado supera el límite de salida de 90 MB.")

            response_headers = {
                "X-CAD-Feature-Count": str(count),
                "X-CAD-Original-Name": original_name,
                "X-CAD-Layer-Color": layer_color,
                "X-CAD-Target-CRS": "EPSG:4326",
            }
            if project:
                geojson_directory = project_directory(storage_directories()[1], project)
                persisted_geojson = geojson_directory / f"{layer_id}.geojson"
                os.replace(output, persisted_geojson)
                metadata = {
                    "id": layer_id,
                    "project_id": project,
                    "original_filename": original_name,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "source_crs": crs,
                    "target_crs": "EPSG:4326",
                    "color": layer_color,
                    "feature_count": count,
                    "size_bytes": output_size,
                }
                await asyncio.to_thread(persist_metadata, geojson_directory, layer_id, metadata)
                await asyncio.to_thread(
                    record_event,
                    project_id=project,
                    operation="overlay",
                    filename=original_name,
                    actor=actor,
                    input_bytes=input_size,
                    status="ok",
                    output_format="geojson",
                    output_bytes=output_size,
                )
                response_headers["X-CAD-Layer-ID"] = layer_id
                return file_response(persisted_geojson, None, "application/geo+json", response_headers)

            cleanup_directory = False
            return temporary_file_response(output, None, "application/geo+json", temporary_directory, response_headers)
    except ServiceError as exc:
        if project and input_size:
            await asyncio.to_thread(
                record_event,
                project_id=project,
                operation="overlay",
                filename=original_name,
                actor=actor,
                input_bytes=input_size,
                status="failed",
                output_format="geojson",
                error_code=exc.code,
            )
        raise
    finally:
        if cleanup_directory:
            await asyncio.to_thread(shutil.rmtree, temporary_directory, ignore_errors=True)
        await file.close()


@app.post("/api/convert-media")
async def convert_media(
    file: Annotated[UploadFile, File(...)],
    target_format: Annotated[str, Form(...)],
    source_crs: Annotated[str, Form()] = "auto",
    dpi: Annotated[int, Form()] = 300,
    project_id: Annotated[str, Header(alias="X-Map-Project-ID")] = "",
    actor: Annotated[str | None, Header(alias="X-Admin-Email")] = None,
) -> FileResponse:
    project = validate_project_id(project_id) if project_id.strip() else None
    crs = validate_source_crs(source_crs)
    if dpi not in {MIN_DPI, MAX_DPI}:
        raise ServiceError(400, "INVALID_DPI", f"Seleccione {MIN_DPI} o {MAX_DPI} DPI.")
    original_name = safe_filename(file.filename)
    extension = Path(original_name).suffix.lower()
    target = validate_conversion_pair(extension, target_format)

    temporary_directory = Path(tempfile.mkdtemp(prefix="cad-media-", dir="/tmp"))
    input_size = 0
    cleanup_directory = True
    try:
        if project:
            stored_original, original_name, input_size = await store_upload(file, project)
        else:
            stored_original, original_name, input_size = await store_temporary_upload(file, temporary_directory)

        async with CONVERSION_LOCK:
            if extension == ".pdf":
                generated, download_name, media_type = await render_pdf(stored_original, original_name, target, dpi, temporary_directory)
            elif extension in {".dwg", ".dxf"} and target in {"pdf", "jpg", "png", "svg"}:
                generated, download_name, media_type = await render_cad(stored_original, original_name, target, dpi, temporary_directory)
            else:
                generated = temporary_directory / f"{uuid.uuid4().hex}.{target}"
                await export_vector(stored_original, original_name, crs, target, generated, temporary_directory)
                download_name = safe_filename(f"{safe_stem(original_name)}.{target}")
                media_type = media_type_for(f".{target}")

            output_size = generated.stat().st_size
            if output_size > MAX_OUTPUT_BYTES:
                raise ServiceError(413, "OUTPUT_TOO_LARGE", "El archivo generado supera el límite de salida de 90 MB.")

            if project:
                persisted, download_name, output_size = await asyncio.to_thread(
                    persist_export,
                    generated,
                    project,
                    download_name,
                    actor,
                    "document_export",
                    input_size,
                    target,
                )
                return file_response(
                    persisted,
                    download_name,
                    media_type,
                    {"X-CAD-Export-Bytes": str(output_size)},
                )

            response = temporary_file_response(
                generated,
                download_name,
                media_type,
                temporary_directory,
                {"X-CAD-Export-Bytes": str(output_size)},
            )
            cleanup_directory = False
            return response
    except ServiceError as exc:
        if project and input_size:
            await asyncio.to_thread(
                record_event,
                project_id=project,
                operation="document_export",
                filename=original_name,
                actor=actor,
                input_bytes=input_size,
                status="failed",
                output_format=target,
                error_code=exc.code,
            )
        raise
    finally:
        if cleanup_directory:
            await asyncio.to_thread(shutil.rmtree, temporary_directory, ignore_errors=True)
        await file.close()


@app.get("/api/saved-layers/{project_id}")
async def list_saved_layers(project_id: str) -> dict[str, Any]:
    project = validate_project_id(project_id)
    directory = project_directory(storage_directories()[1], project)
    layers: list[dict[str, Any]] = []
    for metadata_path in directory.glob("*.meta.json"):
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            LOGGER.warning("skipping malformed CAD metadata: %s", metadata_path.name)
            continue
        layer_id = metadata.get("id") if isinstance(metadata, dict) else None
        if not isinstance(layer_id, str) or not LAYER_ID_RE.fullmatch(layer_id):
            continue
        if not (directory / f"{layer_id}.geojson").is_file():
            continue
        layers.append({key: metadata.get(key) for key in (
            "id", "project_id", "original_filename", "created_at", "source_crs",
            "target_crs", "color", "feature_count", "size_bytes",
        )})
    layers.sort(key=lambda item: str(item.get("created_at", "")), reverse=True)
    return {"data": layers}


@app.get("/api/saved-layers/{project_id}/{layer_id}")
async def get_saved_layer(project_id: str, layer_id: str) -> FileResponse:
    project = validate_project_id(project_id)
    layer = validate_layer_id(layer_id)
    directory = project_directory(storage_directories()[1], project)
    metadata_path = directory / f"{layer}.meta.json"
    geojson_path = directory / f"{layer}.geojson"
    if not metadata_path.is_file() or not geojson_path.is_file():
        raise ServiceError(404, "LAYER_NOT_FOUND", "No se encontró esa capa.")
    return file_response(geojson_path, None, "application/geo+json")
