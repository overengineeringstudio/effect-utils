import importlib.util
import json
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

    def test_latest_stable_version_ignores_order_and_latest_label(self):
        pages = [
            [{"tag_name": tag, "draft": False, "prerelease": False}
             for tag in ("v11.29.0", "v12.23.0", "v12.9.0")],
            [{"tag_name": "v12.24.0", "draft": False, "prerelease": False}],
        ]
        self.assertEqual(updater.latest_stable_version(pages), "12.24.0")

    def test_latest_stable_version_excludes_drafts_prereleases_and_other_tags(self):
        releases = [
            {"tag_name": "v99.0.0", "draft": True, "prerelease": False},
            {"tag_name": "v98.0.0", "draft": False, "prerelease": True},
        ] + [
            {"tag_name": tag, "draft": False, "prerelease": False}
            for tag in ("pnpr@99.0.0", "v97.0.0-rc.1", "v096.0.0", "v95.0.0+build", "v94.0.0\n")
        ] + [{"tag_name": "v12.24.0", "draft": False, "prerelease": False}]
        self.assertEqual(updater.latest_stable_version([releases]), "12.24.0")

    def test_no_canonical_stable_release_fails_closed(self):
        for pages in ([], [[]], [[{"tag_name": "pnpr@1.0.0", "draft": False, "prerelease": False}]]):
            with self.subTest(pages=pages), self.assertRaises(RuntimeError):
                updater.latest_stable_version(pages)

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

    def test_namespace_runner_admits_nix_before_resolving_tools(self):
        workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/update-pnpm.yml").read_text()
        self.assertIn("namespace-profile-linux-x86-64;github.run-id=", workflow)
        self.assertIn("container.privileged=true", workflow)
        self.assertNotIn("runs-on: [sh-linux-x64", workflow)
        self.assertLess(workflow.index("id: linux-sandbox-admission"), workflow.index("resolve-devenv.sh"))
        ledger = json.loads((Path(__file__).resolve().parents[1] / "genie/ci-workflow/policy-migration-ledger.json").read_text())
        rows = [row for row in ledger["violations"] if row["workflow"] == "update-pnpm.yml"]
        self.assertEqual({row["rule"] for row in rows}, {"runner-fallback", "dynamic-runner"})
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(row["job"], "candidate")
            self.assertEqual(row["path"], "jobs.candidate.runs-on")
            self.assertTrue(row["value"].startswith("namespace-profile-linux-x86-64;github.run-id="))
            self.assertEqual(row["reason"], "No active sh-linux-x64 runner; same Namespace profile as grandfathered trusted consumers.")


if __name__ == "__main__":
    unittest.main()
