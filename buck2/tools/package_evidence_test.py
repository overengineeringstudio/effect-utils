from __future__ import annotations

import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from buck2.tools.package_evidence import main


class PackageEvidenceTest(unittest.TestCase):
    def fixture(self) -> tuple[tempfile.TemporaryDirectory[str], Path]:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "source.ts").write_text("export const answer = 42\n", encoding="utf-8")
        (root / "tsconfig.json").write_text("{}\n", encoding="utf-8")
        (root / "closure.json").write_text('{"schemaVersion":1}\n', encoding="utf-8")
        return directory, root

    def run_package(self, root: Path, suffix: str = "") -> tuple[Path, Path]:
        archive = root / f"artifact{suffix}.tar"
        descriptor = root / f"descriptor{suffix}.json"
        main([
            "package",
            "--name", "typescript_inputs",
            "--package-path", "packages/example",
            "--kind", "typescript-input-evidence",
            "--target", "root//packages/example:typescript_inputs",
            "--platform", "x86_64-linux",
            "--closure-label", "packages/example/buck2/check.closure.json",
            "--closure-descriptor", str(root / "closure.json"),
            "--source-label", "packages/example/src/mod.ts",
            "--source", str(root / "source.ts"),
            "--config-label", "packages/example/tsconfig.json",
            "--config", str(root / "tsconfig.json"),
            "--archive", str(archive),
            "--descriptor", str(descriptor),
        ])
        return archive, descriptor

    def test_is_byte_deterministic_and_matches_import_contract(self) -> None:
        _, root = self.fixture()
        first_archive, first_descriptor = self.run_package(root, "-one")
        second_archive, second_descriptor = self.run_package(root, "-two")
        self.assertEqual(first_archive.read_bytes(), second_archive.read_bytes())
        self.assertEqual(first_descriptor.read_bytes(), second_descriptor.read_bytes())

        descriptor = json.loads(first_descriptor.read_text())
        self.assertEqual(descriptor["kind"], "buck2-build-artifact")
        self.assertEqual(descriptor["artifact"]["file"], "artifact.tar")
        self.assertEqual(descriptor["artifact"]["sizeBytes"], first_archive.stat().st_size)
        self.assertEqual(descriptor["entrypoints"], ["bin/package-evidence"])
        self.assertTrue(descriptor["artifact"]["digest"]["sri"].startswith("sha256-"))

    def test_archive_contains_only_sanitized_evidence(self) -> None:
        _, root = self.fixture()
        archive, descriptor = self.run_package(root)
        with tarfile.open(archive) as opened:
            names = opened.getnames()
            manifest = opened.extractfile("share/package-evidence/manifest.json")
            assert manifest is not None
            payload = manifest.read()
        self.assertEqual(names, [
            "bin",
            "bin/package-evidence",
            "share",
            "share/package-evidence",
            "share/package-evidence/manifest.json",
        ])
        self.assertNotIn(str(root).encode(), archive.read_bytes())
        self.assertNotIn(str(root).encode(), descriptor.read_bytes())
        self.assertNotIn(str(root).encode(), payload)

    def test_rejects_traversal_before_writing_outputs(self) -> None:
        _, root = self.fixture()
        with self.assertRaisesRegex(SystemExit, "normalized relative path"):
            main([
                "package",
                "--name", "bad",
                "--package-path", "../private",
                "--kind", "evidence",
                "--target", "root//bad:bad",
                "--platform", "x86_64-linux",
                "--closure-label", "closure.json",
                "--closure-descriptor", str(root / "closure.json"),
                "--archive", str(root / "bad.tar"),
                "--descriptor", str(root / "bad.json"),
            ])
        self.assertFalse((root / "bad.tar").exists())

    def test_relevant_content_change_changes_artifact(self) -> None:
        _, root = self.fixture()
        first_archive, _ = self.run_package(root, "-before")
        first = first_archive.read_bytes()
        (root / "source.ts").write_text("export const answer = 43\n", encoding="utf-8")
        second_archive, _ = self.run_package(root, "-after")
        self.assertNotEqual(first, second_archive.read_bytes())


if __name__ == "__main__":
    unittest.main()
