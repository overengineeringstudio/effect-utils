"""Filesystem boundary tests plus optional real bubblewrap/rustc negative control.

Set RUST_SANDBOX_TEST_RUNTIME to the generated sandbox-runtime.json to exercise
actual namespaces. A missing runtime skips only the native probe, not boundary
coverage. The probe requires rustc and Python in the declared immutable closure.
"""
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("fixed_root", Path(__file__).with_name("fixed_root.py"))
fixed_root = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixed_root)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.host = self.root / "host"
        self.host.mkdir()
        self.stage = self.root / "stage"
        self.stage.mkdir()

    def metadata(self, *paths):
        return {"version": 1, "digests": [{"path": path, "digest": hashlib.sha256((self.host / path).read_bytes()).hexdigest() + ":" + str((self.host / path).stat().st_size)} for path in paths]}

    def test_declared_symlink_view_materializes_verified_bytes(self):
        (self.host / "source.rs").write_text("fn main() {}")
        view = self.host / "view"
        view.mkdir()
        (view / "main.rs").symlink_to("../source.rs")
        inputs = fixed_root.Inputs(self.host, self.stage, self.metadata("source.rs"))
        inputs.install(Path("view"))
        self.assertEqual((self.stage / "view/main.rs").read_text(), "fn main() {}")
        self.assertFalse((self.stage / "view/main.rs").is_symlink())
        self.assertEqual((self.stage / "view/main.rs").stat().st_mode & 0o222, 0)

    def test_undeclared_view_member_is_rejected(self):
        (self.host / "view").mkdir()
        (self.host / "view/secret").write_text("undeclared")
        inputs = fixed_root.Inputs(self.host, self.stage, {"version": 1, "digests": []})
        with self.assertRaises(fixed_root.BoundaryError):
            inputs.install(Path("view"))

    def test_input_symlink_escape_is_rejected_even_with_matching_digest(self):
        (self.root / "secret").write_text("outside")
        (self.host / "escape").symlink_to("../secret")
        with self.assertRaises(fixed_root.BoundaryError):
            fixed_root.Inputs(self.host, self.stage, self.metadata("escape"))

    def test_input_parent_symlink_escape_is_rejected(self):
        (self.root / "outside").mkdir()
        (self.root / "outside/input").write_text("outside")
        (self.host / "alias").symlink_to("../outside", target_is_directory=True)
        with self.assertRaises(fixed_root.BoundaryError):
            fixed_root.Inputs(self.host, self.stage, self.metadata("alias/input"))

    def test_changed_digest_is_rejected(self):
        (self.host / "input").write_text("before")
        metadata = self.metadata("input")
        (self.host / "input").write_text("after")
        with self.assertRaises(fixed_root.BoundaryError):
            fixed_root.Inputs(self.host, self.stage, metadata)

    def test_response_files_must_be_declared_and_cannot_cycle(self):
        (self.host / "args").write_text("@args\n")
        inputs = fixed_root.Inputs(self.host, self.stage, self.metadata("args"))
        with self.assertRaises(fixed_root.BoundaryError):
            fixed_root._expand(["@args"], inputs)
        (self.host / "other").write_text("argument\n")
        with self.assertRaises(fixed_root.BoundaryError):
            fixed_root._expand(["@other"], inputs)

    def test_path_escape_and_nested_outputs_are_rejected(self):
        for path in ("../escape", "/absolute", ".", "a/../../escape", ""):
            with self.subTest(path=path), self.assertRaises(fixed_root.BoundaryError):
                fixed_root._outputs({"outputs": [path]})
        with self.assertRaises(fixed_root.BoundaryError):
            fixed_root._outputs({"outputs": ["directory", "directory/file"]})

    def publish(self, *outputs):
        fixed_root._publish(self.host, self.stage, [Path(path) for path in outputs], self.root)

    def test_missing_output_does_not_publish_other_output(self):
        (self.stage / "good").write_text("new")
        (self.host / "good").write_text("old")
        with self.assertRaises(fixed_root.BoundaryError):
            self.publish("good", "missing")
        self.assertEqual((self.host / "good").read_text(), "old")

    def test_output_symlink_does_not_publish_other_output(self):
        (self.stage / "good").write_text("new")
        (self.stage / "bad").symlink_to("good")
        with self.assertRaises(fixed_root.BoundaryError):
            self.publish("good", "bad")
        self.assertFalse((self.host / "good").exists())

    def test_nested_output_symlink_is_rejected(self):
        (self.stage / "directory").mkdir()
        (self.stage / "directory/escape").symlink_to(self.host)
        with self.assertRaises(fixed_root.BoundaryError):
            self.publish("directory")
        self.assertFalse((self.host / "directory").exists())

    def test_special_output_is_rejected_without_blocking(self):
        os.mkfifo(self.stage / "pipe")
        with self.assertRaises(fixed_root.BoundaryError):
            self.publish("pipe")

    def test_host_parent_symlink_cannot_receive_output(self):
        (self.stage / "directory").mkdir()
        (self.stage / "directory/file").write_text("new")
        (self.root / "outside").mkdir()
        (self.host / "directory").symlink_to("../outside", target_is_directory=True)
        with self.assertRaises(fixed_root.BoundaryError):
            self.publish("directory/file")
        self.assertFalse((self.root / "outside/file").exists())

    def test_dangling_host_output_symlink_is_rejected(self):
        (self.stage / "output").write_text("new")
        (self.host / "output").symlink_to("missing")
        with self.assertRaises(fixed_root.BoundaryError):
            self.publish("output")
        self.assertTrue((self.host / "output").is_symlink())

    def test_only_declared_outputs_are_published(self):
        (self.stage / "out").mkdir()
        (self.stage / "out/program").write_text("binary")
        (self.stage / "out/program").chmod(0o755)
        (self.stage / "undeclared").write_text("ignored")
        self.publish("out")
        self.assertEqual((self.host / "out/program").read_text(), "binary")
        self.assertTrue((self.host / "out/program").stat().st_mode & 0o111)
        self.assertFalse((self.host / "undeclared").exists())

    def test_recursive_launch_is_rejected(self):
        previous = os.environ.get("RUST_SANDBOX_INNER")
        os.environ["RUST_SANDBOX_INNER"] = "1"
        try:
            with self.assertRaises(fixed_root.BoundaryError):
                fixed_root.launch("action.py", [])
        finally:
            if previous is None:
                os.environ.pop("RUST_SANDBOX_INNER")
            else:
                os.environ["RUST_SANDBOX_INNER"] = previous


@unittest.skipUnless(os.environ.get("RUST_SANDBOX_TEST_RUNTIME"), "generated native runtime not supplied")
class NativeProbeTests(unittest.TestCase):
    def test_positive_and_root_dependent_negative_control(self):
        runtime_path = Path(os.environ["RUST_SANDBOX_TEST_RUNTIME"]).resolve()
        runtime = json.loads(runtime_path.read_text())
        rustcs = [Path(root) / "bin/rustc" for root in runtime["storePaths"] if (Path(root) / "bin/rustc").is_file()]
        self.assertTrue(rustcs, "declared closure must supply rustc")
        rustc = str(rustcs[0])
        with tempfile.TemporaryDirectory() as temporary:
            host = Path(temporary)
            shutil.copyfile(Path(__file__).with_name("fixed_root.py"), host / "fixed_root.py")
            shutil.copyfile(runtime_path, host / "sandbox-runtime.json")
            shutil.copyfile(runtime["env"], host / "sandbox-env")
            (host / "sandbox-env").chmod(0o755)
            (host / "q42-root-dependent.txt").write_text("must stay invisible")
            (host / "action.py").write_text(
                "import os, subprocess, sys\n"
                "from fixed_root import launch\n"
                "if os.environ.get('RUST_SANDBOX_INNER') != '1':\n"
                "    sys.exit(launch(__file__, sys.argv[1:]))\n"
                "assert os.getcwd() == os.environ['PWD'] == '/build'\n"
                "assert os.environ['HOME'] == '/home/build'\n"
                "assert os.environ['TMPDIR'] == '/tmp'\n"
                "assert not os.path.exists('/build/q42-root-dependent.txt')\n"
                "assert not os.path.exists('/etc/passwd')\n"
                "sys.exit(subprocess.call(sys.argv[1:]))\n"
            )
            manifest = {"outputs": ["out/program"], "views": []}
            (host / "outputs.json").write_text(json.dumps(manifest))
            for negative in (False, True):
                with self.subTest(negative=negative):
                    if (host / "out").exists():
                        shutil.rmtree(host / "out")
                    source = 'const ROOT_INPUT: &str = include_str!(concat!(env!("PWD"), "/q42-root-dependent.txt"));\nfn main() { println!("{ROOT_INPUT}"); }\n' if negative else 'fn main() { println!("declared"); }\n'
                    (host / "main.rs").write_text(source)
                    paths = ("fixed_root.py", "sandbox-env", "action.py", "outputs.json", "main.rs")
                    metadata = {"version": 1, "digests": [{"path": path, "digest": hashlib.sha256((host / path).read_bytes()).hexdigest() + ":" + str((host / path).stat().st_size)} for path in paths]}
                    (host / "metadata.json").write_text(json.dumps(metadata))
                    environment = dict(os.environ, RUST_SANDBOX_METADATA=str(host / "metadata.json"))
                    environment.pop("RUST_SANDBOX_INNER", None)
                    result = subprocess.run([sys.executable, "action.py", "--sandbox-outputs=outputs.json", rustc, "main.rs", "-o", "out/program"], cwd=host, env=environment, capture_output=True, text=True, check=False)
                    if negative:
                        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertIn("q42-root-dependent.txt", result.stderr)
                        self.assertFalse((host / "out/program").exists())
                    else:
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertTrue((host / "out/program").is_file())


if __name__ == "__main__":
    unittest.main()
