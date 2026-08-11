import argparse
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

from buck2.tools.typescript_cli import bundle


class TypescriptCliBuilderTest(unittest.TestCase):
    def test_rejects_missing_declared_entry(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bun = root / "bun"
            bun.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            bun.chmod(0o755)
            patchelf = root / "patchelf"
            patchelf.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            patchelf.chmod(0o755)
            (root / "deps" / "node_modules").mkdir(parents=True)
            read_only_package = root / "deps" / "node_modules" / "package"
            read_only_package.mkdir()
            (read_only_package / "index.js").write_text("export {}\n", encoding="utf-8")
            read_only_package.chmod(0o555)
            (root / "deps" / "packages").mkdir()
            source = root / "other.ts"
            source.write_text("export {}\n", encoding="utf-8")
            args = argparse.Namespace(
                bun=str(bun),
                patchelf=str(patchelf),
                validation=str(root / "validation.json"),
                validation_project="pkg/tsconfig.json",
                dependency_root=str(root / "deps"),
                native_package=[],
                entry="pkg/main.ts",
                binary_name="tool",
                revision="abc1234",
                commit_timestamp=1,
                dirty="false",
                output=str(root / "out"),
                archive=str(root / "artifact.tar"),
                descriptor=str(root / "descriptor.json"),
                target="//pkg:tool",
                platform="x86_64-linux",
                source_label=["pkg/other.ts"],
                source=[str(source)],
                source_tree_prefix=[],
                source_tree=[],
            )
            (root / "validation.json").write_text(
                '{"project":"pkg/tsconfig.json","schema":"effect-utils-buck2-typescript-check/v1"}\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "entry is absent"):
                bundle(args)
            (root / "validation.json").write_text(
                '{"project":"other/tsconfig.json","schema":"effect-utils-buck2-typescript-check/v1"}\n',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "different project"):
                bundle(args)

    def test_compiles_with_stable_output_name_and_writes_descriptor(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            bun = root / "bun"
            bun.write_text(
                f"#!{sys.executable}\n"
                "import pathlib\n"
                "import shutil\n"
                "import sys\n"
                "entry = pathlib.Path(sys.argv[2])\n"
                "output = pathlib.Path(sys.argv[sys.argv.index('--outfile') + 1])\n"
                "shutil.copyfile(entry, output)\n",
                encoding="utf-8",
            )
            bun.chmod(0o755)
            patchelf = root / "patchelf"
            patchelf.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            patchelf.chmod(0o755)
            (root / "deps" / "node_modules").mkdir(parents=True)
            (root / "deps" / "packages").mkdir()
            source = root / "main.ts"
            source.write_text("export {}\n", encoding="utf-8")
            output = root / "result" / "mr"
            descriptor = root / "result" / "descriptor.json"
            archive = root / "result" / "artifact.tar"
            args = argparse.Namespace(
                bun=str(bun),
                patchelf=str(patchelf),
                validation=str(root / "validation.json"),
                validation_project="pkg/tsconfig.json",
                dependency_root=str(root / "deps"),
                native_package=[],
                entry="pkg/main.ts",
                binary_name="mr",
                revision="abc1234",
                commit_timestamp=1,
                dirty="false",
                output=str(output),
                archive=str(archive),
                descriptor=str(descriptor),
                target="//pkg:mr",
                platform="x86_64-linux",
                source_label=["pkg/main.ts"],
                source=[str(source)],
                source_tree_prefix=[],
                source_tree=[],
            )
            (root / "validation.json").write_text(
                '{"project":"pkg/tsconfig.json","schema":"effect-utils-buck2-typescript-check/v1"}\n',
                encoding="utf-8",
            )
            source.write_text(
                "const buildStamp = '__CLI_BUILD_STAMP__'\nexport {}\n", encoding="utf-8"
            )
            bundle(args)
            self.assertIn(b"abc1234", output.read_bytes())
            self.assertNotIn(b"__CLI_BUILD_STAMP__", output.read_bytes())
            payload = json.loads(descriptor.read_text(encoding="utf-8"))
            self.assertEqual(payload["provenance"]["target"], "//pkg:mr")
            self.assertEqual(payload["artifact"]["file"], "artifact.tar")
            self.assertEqual(payload["artifact"]["format"], "tar")
            self.assertTrue(payload["artifact"]["digest"]["sri"].startswith("sha256-"))
            self.assertEqual(payload["artifact"]["sizeBytes"], archive.stat().st_size)
            self.assertNotIn("actionDigest", payload["provenance"])
            self.assertTrue(payload["provenance"]["declaredInputDigest"].startswith("sha256:"))
            with tarfile.open(archive) as tar:
                binary = tar.extractfile("bin/mr")
                self.assertIsNotNone(binary)
                assert binary is not None
                self.assertEqual(binary.read(), output.read_bytes())
                self.assertEqual(tar.getmember("bin/mr").mode, 0o555)


if __name__ == "__main__":
    unittest.main()
