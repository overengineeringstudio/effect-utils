import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).with_name("editor-view-receipt.py")
SPEC = importlib.util.spec_from_file_location("editor_view_receipt", HELPER)
receipt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(receipt)


class ReceiptTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "repo"
        self.root.mkdir()
        self.env = {**os.environ, "GITHUB_RUN_ID": "1", "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_JOB": "unit", "RUNNER_TEMP": self.temporary.name}
        for name in ("devenv.nix", "nix/devenv-modules/tasks/shared/test.nix",
                     "scripts/editor-view-authority.ts", "scripts/editor-view-receipt.py",
                     "pnpm-lock.yaml", "outside-receipt-scope.txt",
                     "packages/@overeng/buck2-tools/src/editor-view.ts",
                     "packages/@overeng/demo/src/index.ts", "packages/@overeng/leaf/src/index.ts"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("version-one")
        (self.root / "pnpm-lock.yaml").write_text(json.dumps({"importers": {
            ".": {}, "packages/@overeng/otel-contract": {}, "packages/@overeng/leaf": {},
            "packages/@overeng/demo": {"dependencies": {"leaf": {
                "specifier": "workspace:*", "version": "link:../leaf"}}},
        }}))
        (self.root / "BUCK").write_text(
            'alias(name = "editor_inputs", actual = "//packages/@overeng/demo:editor_inputs")\n'
            'alias(name = "root_editor_package_tree", actual = "//packages/@overeng/demo:package_tree")\n')
        (self.root / ".gitignore").write_text(".devenv/\n.editor-view/\nnode_modules\n")
        with (self.root / "packages/@overeng/buck2-tools/large-clean-input.bin").open("wb") as source:
            source.truncate(8 * 1024 * 1024)
        self.git("init", "-q")
        self.git("add", ".")
        self.git("config", "commit.gpgsign", "false")
        email = subprocess.run(["git", "config", "user.email"], capture_output=True, text=True).stdout.strip()
        name = subprocess.run(["git", "config", "user.name"], capture_output=True, text=True).stdout.strip()
        self.git("-c", f"user.name={name or 'Receipt test'}", "-c", f"user.email={email or 'test@example.com'}", "commit", "-qm", "fixture")
        authority = self.root / ".devenv/editor-workspace-authority.json"
        authority.parent.mkdir()
        authority.write_text("authority-one")
        snapshot = self.root / ".editor-view/.store/root-digest"
        snapshot.mkdir(parents=True)
        (snapshot / "editor-view.json").write_text("snapshot-one")
        (snapshot.parent.parent / "root").symlink_to(".store/root-digest")
        (self.root / "node_modules").symlink_to(".editor-view/root/node_modules")
        self.run_helper("begin")
        self.run_helper("write")

    def git(self, *args):
        subprocess.run(["git", "-C", str(self.root), *args], check=True, stdout=subprocess.DEVNULL)

    def run_helper(self, action):
        subprocess.run([sys.executable, str(HELPER), action, str(self.root), "publication", '["."]'],
                       env=self.env, check=True, capture_output=True)

    def alias(self, scope='["."]'):
        result = subprocess.run(["bash", "-c",
            'if "$@"; then echo reused; else echo scoped-publication; fi', "alias",
            sys.executable, str(HELPER), "check", str(self.root), "publication", scope],
            env=self.env, check=True, text=True, capture_output=True)
        return result.stdout.strip()

    def test_reuse_and_mismatches_fall_back(self):
        self.assertEqual(self.alias(), "reused")
        for name in (".devenv/editor-workspace-authority.json", "devenv.nix",
                     "packages/@overeng/buck2-tools/src/editor-view.ts",
                     ".editor-view/.store/root-digest/editor-view.json"):
            path = self.root / name
            before = path.read_text()
            path.write_text("changed")
            self.assertEqual(self.alias(), "scoped-publication", name)
            path.write_text(before)
        self.assertEqual(self.alias('[".","missing"]'), "scoped-publication")
        self.env["GITHUB_JOB"] = "different-job"
        self.assertEqual(self.alias(), "scoped-publication")
        self.env["GITHUB_JOB"] = "unit"
        next(Path(self.temporary.name).glob("editor-view-job-*")).unlink()
        self.assertEqual(self.alias(), "scoped-publication")

    def test_changes_during_publication_cannot_issue_receipt(self):
        self.run_helper("begin")
        (self.root / "devenv.nix").write_text("changed during publication")
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_helper("write")
        self.assertEqual(self.alias(), "scoped-publication")

    def test_publication_outputs_do_not_change_git_inputs(self):
        # Explicit output exclusion must work even before ignore rules are installed.
        (self.root / ".gitignore").write_text("")
        self.git("add", ".gitignore")
        before = receipt.git_input_state(self.root, ["."])
        self.run_helper("begin")
        (self.root / ".editor-view/.store/root-digest/node_modules").mkdir()
        for directory in (".editor-view", ".devenv", "node_modules",
                          "packages/@overeng/buck2-tools/.editor-view",
                          "packages/@overeng/buck2-tools/node_modules"):
            path = self.root / directory / "published-output"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"publication output")
        self.assertEqual(receipt.git_input_state(self.root, ["."]), before)
        self.run_helper("write")
        self.assertEqual(self.alias(), "reused")

    def test_fingerprint_reads_only_changed_input_bytes(self):
        (self.root / "devenv.nix").write_text("changed")
        source = self.root / "packages/@overeng/buck2-tools/untracked source.txt"
        source.write_text("untracked")
        with patch.object(receipt, "file_digest", wraps=receipt.file_digest) as opened, \
             patch.object(Path, "read_bytes", side_effect=AssertionError("whole-file read")):
            before = receipt.git_input_state(self.root, ["."])
        paths = [call.args[0] for call in opened.call_args_list]
        self.assertEqual(set(paths), {self.root / "devenv.nix", source})
        self.assertEqual(len(paths), 2)
        self.assertLessEqual(sum(path.stat().st_size for path in paths), 32)
        source.write_text("different")
        self.assertNotEqual(receipt.git_input_state(self.root, ["."]), before)

    def test_scope_excludes_unrelated_ci_writes(self):
        scope = [".", "packages/@overeng/demo", "packages/@overeng/otel-contract"]
        sources = [self.root / package / "src/index.ts" for package in scope[1:]]
        for source in sources:
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text("source")
        before = receipt.git_input_state(self.root, scope)
        self.run_helper("begin")
        (self.root / "outside-receipt-scope.txt").write_text("unrelated tracked change")
        artifact = self.root / "ci-artifacts/report.json"
        artifact.parent.mkdir()
        artifact.write_text("unrelated untracked output")
        self.assertEqual(receipt.git_input_state(self.root, scope), before)
        self.run_helper("write")
        self.assertEqual(self.alias(), "reused")
        for source in [*sources, self.root / "packages/@overeng/buck2-tools/src/editor-view.ts"]:
            original = source.read_text()
            source.write_text("changed publication input")
            self.assertNotEqual(receipt.git_input_state(self.root, scope), before, str(source))
            source.write_text(original)
        lock = self.root / "pnpm-lock.yaml"
        lock.write_text(lock.read_text() + "\n")
        self.assertNotEqual(receipt.git_input_state(self.root, scope), before)

    def test_transitive_workspace_source_invalidates_bootstrap_receipt(self):
        state = receipt.git_input_state(self.root, ["."])
        self.assertEqual(state["inputPaths"], [".", "packages/@overeng/demo", "packages/@overeng/leaf"])
        self.run_helper("begin")
        (self.root / "packages/@overeng/leaf/src/index.ts").write_text("transitive change")
        self.assertEqual(self.alias(), "scoped-publication")
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_helper("write")

    def test_unproven_workspace_closure_issues_no_receipt(self):
        lock = self.root / "pnpm-lock.yaml"
        data = json.loads(lock.read_text())
        del data["importers"]["packages/@overeng/leaf"]
        lock.write_text(json.dumps(data))
        with self.assertRaises(subprocess.CalledProcessError):
            self.run_helper("begin")
        self.assertEqual(self.alias(), "scoped-publication")

    def test_input_drift_reports_at_most_ten_paths(self):
        self.run_helper("begin")
        paths = [f"packages/@overeng/buck2-tools/src/new-{index:02}.ts" for index in range(25)]
        for name in paths:
            (self.root / name).write_text("new publication input")
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.run_helper("write")
        diagnostic = failure.exception.stderr.decode()
        changed = json.loads(diagnostic.split("paths=", 1)[1].split("; headChanged=", 1)[0])
        self.assertEqual(changed, paths[:10])


if __name__ == "__main__":
    unittest.main()
