from __future__ import annotations

import unittest

from pathlib import PurePosixPath

from buck2.tools.portable_toolchain import (
    normalized_relative_path,
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


if __name__ == "__main__":
    unittest.main()
