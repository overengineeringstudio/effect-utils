from __future__ import annotations

import io
import tarfile
import tempfile
import unittest

from pathlib import Path, PurePosixPath

from buck2.tools.portable_toolchain import (
    normalized_relative_path,
    validate_archive_end,
    validate_archive,
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

    def test_rejects_oversized_archive_member_before_staging(self) -> None:
        member = tarfile.TarInfo("oversized")
        member.size = 1024 * 1024 * 1024 + 1
        with self.assertRaisesRegex(SystemExit, "exceeds extracted-size limit"):
            validate_archive(type("Archive", (), {"getmembers": lambda self: [member]})())

    def test_rejects_sparse_archive_member_before_staging(self) -> None:
        member = tarfile.TarInfo("sparse")
        member.size = 1024
        member.sparse = [(0, 1)]
        with self.assertRaisesRegex(SystemExit, "sparse archive member"):
            validate_archive(type("Archive", (), {"getmembers": lambda self: [member]})())

    def test_rejects_aggregate_archive_size_before_staging(self) -> None:
        members = []
        for index in range(5):
            member = tarfile.TarInfo(f"part-{index}")
            member.size = 900 * 1024 * 1024
            members.append(member)
        with self.assertRaisesRegex(SystemExit, "aggregate extracted-size limit"):
            validate_archive(type("Archive", (), {"getmembers": lambda self: members})())

    def test_rejects_nonzero_bytes_after_physical_tar_end_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory, "artifact.tar")
            with tarfile.open(archive_path, "w", format=tarfile.GNU_FORMAT) as archive:
                member = tarfile.TarInfo("bin/tool")
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
            with archive_path.open("ab") as archive:
                archive.write(b"EVIL")
            with tarfile.open(archive_path, "r:") as archive:
                archive.getmembers()
                logical_end = archive.offset
            with self.assertRaisesRegex(SystemExit, "physical end marker"):
                validate_archive_end(archive_path, logical_end)

    def test_accepts_zero_filled_physical_tar_end_marker(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            archive_path = Path(directory, "artifact.tar")
            with tarfile.open(archive_path, "w", format=tarfile.GNU_FORMAT) as archive:
                member = tarfile.TarInfo("bin/tool")
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
            with tarfile.open(archive_path, "r:") as archive:
                archive.getmembers()
                logical_end = archive.offset
            validate_archive_end(archive_path, logical_end)


if __name__ == "__main__":
    unittest.main()
