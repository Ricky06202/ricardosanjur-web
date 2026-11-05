import stat
import csv
import tempfile
import unittest
import zipfile
from pathlib import Path

import main
from main import (
    ServiceError,
    record_event,
    safe_extract_shapefile,
    safe_filename,
    safe_stem,
    validate_conversion_pair,
    validate_project_id,
    validate_source_crs,
    require_source_crs,
)


class ConverterSecurityTests(unittest.TestCase):
    def test_project_id_rejects_path_traversal(self) -> None:
        with self.assertRaises(ServiceError):
            validate_project_id("../../secret")

    def test_project_id_accepts_public_slug(self) -> None:
        self.assertEqual(validate_project_id("pameda-2026"), "pameda-2026")

    def test_crs_allowlist_rejects_arbitrary_definitions(self) -> None:
        self.assertEqual(validate_source_crs("epsg:32617"), "EPSG:32617")
        with self.assertRaises(ServiceError):
            validate_source_crs("+proj=longlat +datum=WGS84")

    def test_filename_discards_path_and_control_characters(self) -> None:
        result = safe_filename("../../Lote 4\n;$(id).dxf")
        self.assertNotIn("/", result)
        self.assertNotIn("\n", result)
        self.assertTrue(result.endswith(".dxf"))
        self.assertEqual(safe_stem("../../Lote 4.dxf"), "Lote_4")

    def test_zip_slip_is_rejected_before_extraction(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "unsafe.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("../outside.shp", "bad")
            with self.assertRaises(ServiceError):
                safe_extract_shapefile(archive_path, root / "out")
            self.assertFalse((root / "outside.shp").exists())

    def test_zip_requires_a_complete_single_shapefile_dataset(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "valid.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("parcelas/lote.shp", "shape")
                archive.writestr("parcelas/lote.shx", "index")
                archive.writestr("parcelas/lote.dbf", "attributes")
                archive.writestr("parcelas/lote.prj", "projection")
                archive.writestr("parcelas/nota.txt", "ignored")
            result = safe_extract_shapefile(archive_path, root / "out")
            self.assertTrue(result.is_file())
            self.assertEqual(result.suffix, ".shp")
            self.assertTrue(result.with_suffix(".prj").is_file())
            self.assertFalse((root / "out" / "parcelas" / "nota.txt").exists())

    def test_media_formats_are_limited_by_input_type(self) -> None:
        self.assertEqual(validate_conversion_pair(".pdf", "jpg"), "jpg")
        self.assertEqual(validate_conversion_pair(".dxf", "pdf"), "pdf")
        with self.assertRaises(ServiceError):
            validate_conversion_pair(".pdf", "pdf")
        with self.assertRaises(ServiceError):
            validate_conversion_pair(".jpg", "geojson")


    def test_zip_symlinks_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive_path = root / "symlink.zip"
            symlink = zipfile.ZipInfo("parcelas/lote.shp")
            symlink.create_system = 3
            symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr(symlink, "../../outside.shp")
            with self.assertRaises(ServiceError):
                safe_extract_shapefile(archive_path, root / "out")

    def test_unreferenced_cad_and_shapefiles_require_an_explicit_crs(self) -> None:
        with self.assertRaises(ServiceError):
            require_source_crs("auto", ".dxf", False)
        with self.assertRaises(ServiceError):
            require_source_crs("auto", ".shp", False)
        require_source_crs("auto", ".shp", True)

    def test_shapefile_upload_requires_a_zip_with_its_companions(self) -> None:
        with self.assertRaises(ServiceError) as context:
            validate_conversion_pair(".shp", "geojson")
        self.assertEqual(context.exception.code, "SHAPEFILE_ZIP_REQUIRED")

    def test_audit_csv_appends_rows_without_repeating_its_header(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            original_data_dir = main.DATA_DIR
            main.DATA_DIR = Path(temporary) / "data"
            try:
                record_event(
                    project_id="pameda-2026",
                    operation="overlay",
                    filename='plano, "final".dxf',
                    actor="admin@example.com",
                    input_bytes=120,
                    status="ok",
                    output_format="geojson",
                    output_bytes=300,
                )
                record_event(
                    project_id="pameda-2026",
                    operation="document_export",
                    filename="plano.dxf",
                    actor="admin@example.com",
                    input_bytes=120,
                    status="failed",
                    output_format="pdf",
                    error_code="CONVERSION_FAILED",
                )
                log_path = main.DATA_DIR / "logs" / "historial_subidas.csv"
                with log_path.open(encoding="utf-8", newline="") as audit_file:
                    rows = list(csv.DictReader(audit_file))
                self.assertEqual(len(rows), 2)
                self.assertEqual(rows[0]["filename"], 'plano, "final".dxf')
                self.assertEqual(rows[1]["status"], "failed")
                self.assertEqual(stat.S_IMODE(log_path.stat().st_mode), 0o640)
            finally:
                main.DATA_DIR = original_data_dir


if __name__ == "__main__":
    unittest.main()
