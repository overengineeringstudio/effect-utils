import argparse
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from buck2.tools.native_binary_artifact import (
    _nix_executable,
    _scrub_removed_dynamic_paths,
    package,
)


class NativeBinaryArtifactTest(unittest.TestCase):
    def _tools(self, root: Path) -> tuple[Path, Path, Path]:
        python = root / "python"
        python.write_text("#!/usr/bin/python3\n", encoding="utf-8")
        python.chmod(0o755)
        strip = root / "strip"
        strip.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        strip.chmod(0o755)
        patchelf = root / "patchelf"
        patchelf.write_text(
            "#!/bin/sh\n"
            "if [ \"$1\" = --print-interpreter ]; then echo /lib64/ld-linux-x86-64.so.2; fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        patchelf.chmod(0o755)
        return python, patchelf, strip

    def _args(self, root: Path, suffix: str = "one") -> argparse.Namespace:
        source = root / "input"
        if not source.exists():
            source.write_bytes(b"\x7fELFdeterministic binary payload")
            source.chmod(0o755)
        python, patchelf, strip = self._tools(root)
        return argparse.Namespace(
            input=str(source),
            output=str(root / suffix / "otel-scrape"),
            archive=str(root / suffix / "artifact.tar"),
            descriptor=str(root / suffix / "descriptor.json"),
            binary_name="otel-scrape",
            binary_target="//packages/@overeng/otel-scrape:otel-scrape",
            platform="x86_64-linux",
            target="//packages/@overeng/otel-scrape:otel-scrape-artifact",
            python=str(python),
            builder_source=__file__,
            patchelf=str(patchelf),
            strip=str(strip),
            revision="0123456789abcdef0123456789abcdef01234567",
            commit_timestamp="1786406400",
            dirty="false",
        )

    def _package(self, args: argparse.Namespace) -> None:
        with patch("buck2.tools.native_binary_artifact._nix_executable", side_effect=lambda value, _role: Path(value)):
            package(args)

    def test_deterministic_ustar_and_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = self._args(root, "one")
            second = self._args(root, "two")
            self._package(first)
            self._package(second)
            self.assertEqual(Path(first.archive).read_bytes(), Path(second.archive).read_bytes())
            self.assertEqual(Path(first.descriptor).read_bytes(), Path(second.descriptor).read_bytes())
            archive_bytes = Path(first.archive).read_bytes()
            self.assertEqual(archive_bytes[257:265], b"ustar\x0000")
            payload = json.loads(Path(first.descriptor).read_text(encoding="utf-8"))
            self.assertNotIn("actionDigest", payload["provenance"])
            self.assertTrue(payload["provenance"]["declaredInputDigest"].startswith("sha256:"))
            self.assertEqual(payload["provenance"]["sourceRevision"], first.revision)
            self.assertEqual(payload["provenance"]["sourceCommitTimestamp"], 1786406400)
            self.assertIs(payload["provenance"]["sourceDirty"], False)
            self.assertEqual(payload["provenance"]["binaryTarget"], first.binary_target)
            self.assertEqual(payload["runtimeAbi"], "glibc-dynamic")
            with tarfile.open(first.archive) as archive:
                member = archive.getmember("bin/otel-scrape")
                self.assertEqual(member.mode, 0o555)
                self.assertEqual(member.mtime, 1)

    def test_binary_mutation_changes_archive_and_declared_input_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first = self._args(root, "one")
            self._package(first)
            Path(first.input).write_bytes(b"\x7fELFmutated binary payload")
            second = self._args(root, "two")
            self._package(second)
            self.assertNotEqual(Path(first.archive).read_bytes(), Path(second.archive).read_bytes())
            first_payload = json.loads(Path(first.descriptor).read_text(encoding="utf-8"))
            second_payload = json.loads(Path(second.descriptor).read_text(encoding="utf-8"))
            self.assertNotEqual(
                first_payload["provenance"]["declaredInputDigest"],
                second_payload["provenance"]["declaredInputDigest"],
            )

    def test_rejects_invalid_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            args = self._args(root)
            Path(args.input).write_text("not ELF", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "ELF executable"):
                self._package(args)
            args = self._args(root)
            args.binary_name = "../escape"
            with self.assertRaisesRegex(ValueError, "safe path component"):
                self._package(args)
            args = self._args(root)
            args.platform = "aarch64-linux"
            with self.assertRaisesRegex(ValueError, "only x86_64-linux"):
                self._package(args)
            args = self._args(root)
            args.revision = "short"
            with self.assertRaisesRegex(ValueError, "40-character Git SHA"):
                self._package(args)
            args = self._args(root)
            args.commit_timestamp = "01"
            with self.assertRaisesRegex(ValueError, "canonical non-negative integer"):
                self._package(args)
            args = self._args(root)
            args.dirty = "maybe"
            with self.assertRaisesRegex(ValueError, "true or false"):
                self._package(args)

    def test_rejects_non_store_tool_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            tool = Path(temporary) / "python"
            tool.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            tool.chmod(0o755)
            with self.assertRaisesRegex(ValueError, "immutable absolute /nix/store path"):
                _nix_executable(str(tool), "Python")
            with self.assertRaisesRegex(ValueError, "canonical Nix store root"):
                _nix_executable("/nix/store/not-canonical/bin/python", "Python")

    def test_rejects_remaining_nix_store_reference(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            args = self._args(Path(temporary))
            Path(args.input).write_bytes(b"\x7fELF/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-secret/bin/tool")
            with self.assertRaisesRegex(ValueError, "still contains a /nix/store reference"):
                self._package(args)

    def test_scrubs_only_one_exact_removed_dynamic_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            binary = Path(temporary) / "binary"
            old_rpath = "/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-lib/lib"
            binary.write_bytes(b"ELF" + old_rpath.encode() + b"\x00tail")
            _scrub_removed_dynamic_paths(binary, (old_rpath,))
            self.assertNotIn(b"/nix/store/", binary.read_bytes())

            binary.write_bytes((old_rpath + "\x00" + old_rpath + "\x00").encode())
            with self.assertRaisesRegex(ValueError, "multiple stale ELF copies"):
                _scrub_removed_dynamic_paths(binary, (old_rpath,))


if __name__ == "__main__":
    unittest.main()
