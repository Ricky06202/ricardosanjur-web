import asyncio
import io
import json
import re
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from starlette.datastructures import UploadFile

from main import (
    ServiceError,
    convert_for_overlay,
    convert_media,
    export_vector,
    pdf_page_count,
    render_cad,
    render_pdf,
    run_command,
    store_temporary_upload,
)


SIMPLE_GEOJSON = {
    "type": "FeatureCollection",
    "features": [
        {
            "type": "Feature",
            "properties": {"Layer": "0"},
            "geometry": {
                "type": "LineString",
                "coordinates": [[500000, 900000], [500100, 900100]],
            },
        }
    ],
}


class ConversionSmokeTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_overlay_is_temporary_and_never_persisted(self) -> None:
        upload = UploadFile(file=io.BytesIO(b"dxf test"), filename="plan.dxf")

        async def write_geojson(_source, _filename, _crs, _format, output, _work_dir):
            output.write_text(
                json.dumps({"type": "FeatureCollection", "features": SIMPLE_GEOJSON["features"]}),
                encoding="utf-8",
            )

        with (
            patch("main.export_vector", new=write_geojson),
            patch("main.project_directory", side_effect=AssertionError("public preview must not use persistent storage")),
            patch("main.persist_metadata", side_effect=AssertionError("public preview must not persist metadata")),
            patch("main.record_event", side_effect=AssertionError("public preview must not log uploaded filenames")),
        ):
            response = await convert_for_overlay(
                file=upload,
                source_crs="EPSG:32617",
                color="#2563eb",
                project_id="",
                actor=None,
            )

        output = Path(response.path)
        temporary_directory = output.parent
        self.assertTrue(output.is_file())
        self.assertTrue(temporary_directory.name.startswith("cad-gis-"))
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertIsNone(response.headers.get("x-cad-layer-id"))
        self.assertIsNotNone(response.background)
        await response.background()
        self.assertFalse(temporary_directory.exists())

    async def test_public_pdf_image_conversion_is_temporary_and_never_persisted(self) -> None:
        upload = UploadFile(file=io.BytesIO(b"%PDF-test"), filename="survey.pdf")

        async def render_temporary_pdf(_source, _filename, _target, _dpi, temporary_directory):
            output = temporary_directory / "survey-page-1.png"
            output.write_bytes(b"temporary png output")
            return output, "survey-page-1.png", "image/png"

        with (
            patch("main.render_pdf", new=render_temporary_pdf),
            patch("main.persist_export", side_effect=AssertionError("public export must not be persisted")),
            patch("main.record_event", side_effect=AssertionError("public export must not log uploaded filenames")),
        ):
            response = await convert_media(
                file=upload,
                target_format="png",
                source_crs="auto",
                dpi=150,
                project_id="",
                actor=None,
            )

        output = Path(response.path)
        temporary_directory = output.parent
        self.assertTrue(output.is_file())
        self.assertEqual(response.media_type, "image/png")
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        self.assertIsNotNone(response.background)
        await response.background()
        self.assertFalse(temporary_directory.exists())

    async def test_public_upload_limit_removes_partial_file(self) -> None:
        upload = UploadFile(file=io.BytesIO(b"four"), filename="too-large.pdf")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            with self.assertRaises(ServiceError) as error:
                await store_temporary_upload(upload, directory, max_bytes=3)
            self.assertEqual(error.exception.status_code, 413)
            self.assertEqual(error.exception.code, "PUBLIC_UPLOAD_TOO_LARGE")
            self.assertEqual(list(directory.iterdir()), [])
        await upload.close()

    async def test_dxf_projects_to_geojson_and_renders_document_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            work_dir = Path(temporary)
            source = work_dir / "line.dxf"
            source_geojson = work_dir / "source.geojson"
            source_geojson.write_text(json.dumps(SIMPLE_GEOJSON), encoding="utf-8")
            await run_command(
                ["ogr2ogr", "-f", "DXF", str(source), str(source_geojson), "-nln", "line"],
                timeout_seconds=30,
            )
            self.assertGreater(source.stat().st_size, 200)

            geojson = work_dir / "line.geojson"
            await export_vector(source, "line.dxf", "EPSG:32617", "geojson", geojson, work_dir)
            collection = json.loads(geojson.read_text(encoding="utf-8"))
            self.assertEqual(collection["type"], "FeatureCollection")
            self.assertGreaterEqual(len(collection["features"]), 1)

            svg, _, svg_media_type = await render_cad(source, "line.dxf", "svg", 150, work_dir)
            self.assertEqual(svg_media_type, "image/svg+xml")
            view_box = re.search(r'viewBox="[-0-9.]+ [-0-9.]+ ([0-9.]+) ([0-9.]+)"', svg.read_text(encoding="utf-8"))
            self.assertIsNotNone(view_box)
            self.assertGreater(float(view_box.group(1)), 0)
            self.assertGreater(float(view_box.group(2)), 0)

            pdf, _, pdf_media_type = await render_cad(source, "line.dxf", "pdf", 150, work_dir)
            self.assertEqual(pdf_media_type, "application/pdf")
            self.assertGreater(await asyncio.to_thread(pdf_page_count, pdf), 0)

            jpg, _, image_media_type = await render_cad(source, "line.dxf", "jpg", 150, work_dir)
            self.assertEqual(image_media_type, "image/jpeg")
            self.assertGreater(jpg.stat().st_size, 0)

            single_page_image, _, image_media_type = await render_pdf(pdf, "line.pdf", "png", 150, work_dir)
            self.assertEqual(image_media_type, "image/png")
            self.assertGreater(single_page_image.stat().st_size, 0)

            multipage_pdf = work_dir / "two-pages.pdf"
            await run_command(["pdfunite", str(pdf), str(pdf), str(multipage_pdf)], timeout_seconds=30)
            archive, _, archive_media_type = await render_pdf(multipage_pdf, "two-pages.pdf", "png", 150, work_dir)
            self.assertEqual(archive_media_type, "application/zip")
            with zipfile.ZipFile(archive) as page_archive:
                self.assertEqual(len(page_archive.namelist()), 2)
                self.assertGreater(len(page_archive.read(page_archive.namelist()[0])), 0)

    async def test_dxf_skips_unsupported_entities_but_rejects_empty_geojson(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            work_dir = Path(temporary)
            source = work_dir / "drawing.dxf"
            source.write_text("fixture", encoding="utf-8")
            output = work_dir / "empty.geojson"
            captured_args: list[str] = []

            async def write_empty_geojson(args: list[str], timeout_seconds: int) -> str:
                captured_args.extend(args)
                Path(args[-2]).write_text(
                    json.dumps({"type": "FeatureCollection", "features": []}),
                    encoding="utf-8",
                )
                return ""

            with patch("main.run_command", new=write_empty_geojson):
                with self.assertRaises(ServiceError) as error:
                    await export_vector(source, "drawing.dxf", "EPSG:32617", "geojson", output, work_dir)

            self.assertIn("-skipfailures", captured_args)
            self.assertEqual(error.exception.status_code, 422)
            self.assertEqual(error.exception.code, "EMPTY_CONVERSION")


if __name__ == "__main__":
    unittest.main()
