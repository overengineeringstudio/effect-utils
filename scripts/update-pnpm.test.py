import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("update_pnpm", Path(__file__).with_name("update-pnpm.py"))
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)


class UpdatePnpmTests(unittest.TestCase):
    def test_stable_versions_sort_numerically(self):
        self.assertGreater(updater.version_tuple("12.23.0"), updater.version_tuple("12.9.0"))
        self.assertGreater(updater.version_tuple("13.0.0"), updater.version_tuple("12.99.9"))

    def test_only_canonical_stable_numeric_versions_are_accepted(self):
        for version in ("latest", "v12.23.0", "12.23", "012.23.0", "12.23.0-rc.1", "12.23.0+build", "12.23.0\n", "../../payload"):
            with self.subTest(version=version), self.assertRaises(RuntimeError):
                updater.version_tuple(version)

    def test_missing_source_pin_fails_without_writing(self):
        task_tmp = Path(__file__).resolve().parents[1] / "tmp"
        task_tmp.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="pnpm-updater-test-", dir=task_tmp) as directory:
            path = Path(directory) / "source"
            path.write_text("unrelated source\n")
            with self.assertRaises(RuntimeError):
                updater.replace(path, "12.23.0", "12.24.0")
            self.assertEqual(path.read_text(), "unrelated source\n")

    def test_pinned_runtime_is_resolved_before_tasks(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/update-pnpm.yml").read_text()
        self.assertLess(workflow.index("resolve-devenv.sh"), workflow.index("DEVENV_BIN:?"))


if __name__ == "__main__":
    unittest.main()
