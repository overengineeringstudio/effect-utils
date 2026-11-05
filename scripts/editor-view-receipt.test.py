import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HELPER = Path(__file__).with_name("editor-view-receipt.py")


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
                     "packages/@overeng/buck2-tools/src/editor-view.ts"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("version-one")
        (self.root / ".gitignore").write_text(".devenv/\n.editor-view/\nnode_modules\n")
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


if __name__ == "__main__":
    unittest.main()
