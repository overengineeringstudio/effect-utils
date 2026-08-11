from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from buck2.tools.closure_tool import read_manifest


class ClosureManifestTest(unittest.TestCase):
    def write(self, value: object) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name, "manifest.json")
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def test_accepts_strict_canonical_shape(self) -> None:
        digest = hashlib.sha256(b"package-a\n").hexdigest()
        manifest = self.write({
            "packages": [{
                "id": "pkg-a@1",
                "projectionPath": "packages/pkg-a.txt",
                "sha256": digest,
            }],
            "schemaVersion": 1,
        })
        self.assertEqual(read_manifest(manifest)[0]["id"], "pkg-a@1")

    def test_rejects_excess_fields(self) -> None:
        manifest = self.write({"packages": [], "schemaVersion": 1, "unexpected": True})
        with self.assertRaisesRegex(SystemExit, "exactly packages and schemaVersion"):
            read_manifest(manifest)

    def test_rejects_noncanonical_order(self) -> None:
        digest = "0" * 64
        manifest = self.write({
            "packages": [
                {"id": "z", "projectionPath": "z", "sha256": digest},
                {"id": "a", "projectionPath": "a", "sha256": digest},
            ],
            "schemaVersion": 1,
        })
        with self.assertRaisesRegex(SystemExit, "strictly increasing"):
            read_manifest(manifest)

    def test_rejects_path_traversal(self) -> None:
        manifest = self.write({
            "packages": [{"id": "pkg", "projectionPath": "../escape", "sha256": "0" * 64}],
            "schemaVersion": 1,
        })
        with self.assertRaisesRegex(SystemExit, "traverse"):
            read_manifest(manifest)

    def test_rejects_reserved_manifest_path(self) -> None:
        manifest = self.write({
            "packages": [{
                "id": "pkg",
                "projectionPath": "closure-manifest.json",
                "sha256": "0" * 64,
            }],
            "schemaVersion": 1,
        })
        with self.assertRaisesRegex(SystemExit, "reserved metadata path"):
            read_manifest(manifest)

    def test_rejects_reserved_manifest_ancestor(self) -> None:
        manifest = self.write({
            "packages": [{
                "id": "pkg",
                "projectionPath": "closure-manifest.json/payload",
                "sha256": "0" * 64,
            }],
            "schemaVersion": 1,
        })
        with self.assertRaisesRegex(SystemExit, "reserved metadata path"):
            read_manifest(manifest)

    def test_rejects_file_ancestor_collision(self) -> None:
        manifest = self.write({
            "packages": [
                {"id": "a", "projectionPath": "packages/a", "sha256": "0" * 64},
                {"id": "b", "projectionPath": "packages/a/b", "sha256": "0" * 64},
            ],
            "schemaVersion": 1,
        })
        with self.assertRaisesRegex(SystemExit, "file/ancestor collision"):
            read_manifest(manifest)


if __name__ == "__main__":
    unittest.main()
