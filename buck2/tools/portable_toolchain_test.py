from __future__ import annotations

import json
from pathlib import Path, PurePosixPath
import tempfile
import unittest

from buck2.tools.portable_toolchain import (
    normalized_relative_path,
    read_descriptor,
    validate_descriptor_platform,
    validate_symlink_target,
)


class PortableToolchainPathTest(unittest.TestCase):
    def test_accepts_normalized_entrypoint(self) -> None:
        self.assertEqual(str(normalized_relative_path("bin/tool", "entrypoint")), "bin/tool")

    def test_rejects_control_characters(self) -> None:
        for value in ("bin/tool\x00suffix", "bin/tool\n", "bin/tool\targ", "bin/tool\x7f"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(SystemExit, "control characters"):
                    normalized_relative_path(value, "entrypoint")

    def test_rejects_non_normalized_paths(self) -> None:
        for value in ("/bin/tool", "bin/../tool", "bin//tool", "./bin/tool", "bin\\tool"):
            with self.subTest(value=value):
                with self.assertRaises(SystemExit):
                    normalized_relative_path(value, "entrypoint")

    def test_accepts_bounded_parent_relative_symlink(self) -> None:
        validate_symlink_target(PurePosixPath("bin/tool"), "../lib/tool")

    def test_rejects_escaping_symlink(self) -> None:
        with self.assertRaisesRegex(SystemExit, "escapes toolchain root"):
            validate_symlink_target(PurePosixPath("bin/tool"), "../../outside")

    def test_accepts_expected_platform(self) -> None:
        validate_descriptor_platform({"platform": "x86_64-linux"}, "x86_64-linux")

    def test_rejects_wrong_platform(self) -> None:
        with self.assertRaisesRegex(SystemExit, "platform mismatch"):
            validate_descriptor_platform({"platform": "x86_64-linux"}, "aarch64-darwin")

    def test_rejects_dynamic_runtime_abi(self) -> None:
        descriptor = {
            "schemaVersion": 1,
            "kind": "buck2-portable-toolchain-artifact",
            "name": "fixture",
            "platform": "x86_64-linux",
            "runtimeAbi": "glibc-dynamic",
            "artifact": {
                "file": "artifact.tar",
                "format": "tar",
                "digest": {"algorithm": "sha256", "sri": "sha256-fixture"},
                "sizeBytes": 1,
            },
            "entrypoints": ["bin/tool"],
            "normalization": {},
            "provenance": {},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, "descriptor.json")
            path.write_text(json.dumps(descriptor), encoding="utf-8")
            with self.assertRaisesRegex(SystemExit, "runtimeAbi must be portable"):
                read_descriptor(path, "bin/tool")


if __name__ == "__main__":
    unittest.main()
