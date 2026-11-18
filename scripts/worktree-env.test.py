"""Real Git/closure fixtures for the worktree publication identity boundary."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("worktree_env", Path(__file__).with_name("worktree-env.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Publication(unittest.TestCase):
    def setUp(self):
        self.previous = Path.cwd()
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"])
        self.root = Path(self.scratch.name).resolve()
        os.chdir(self.root)
        subprocess.run(["git", "init", "-q"], check=True)
        (self.root / ".gitignore").write_text(".worktree-tools/\n")
        (self.root / "source").write_text("before\n")
        subprocess.run(["git", "add", "."], check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], check=True)

    def tearDown(self):
        os.chdir(self.previous)
        self.scratch.cleanup()

    def test_staged_and_unstaged_identity(self):
        before = module.identity(self.root)
        (self.root / "source").write_text("after\n")
        after = module.identity(self.root)
        self.assertNotEqual(before, after)
        subprocess.run(["git", "add", "source"], check=True)
        self.assertEqual(after, module.identity(self.root))
        (self.root / "new-source").write_text("new\n")
        with self.assertRaisesRegex(RuntimeError, "Stage new source"):
            module.identity(self.root)

    def test_immutable_selection_and_stale_manifest(self):
        tools = Path(os.environ["WORKTREE_TEST_TOOLS"]).resolve(strict=True)
        state = self.root / ".worktree-tools/v1"
        generation = state / "generation-fixture"
        generation.mkdir(parents=True)
        (generation / "tools").symlink_to(tools)
        key = module.identity(self.root)
        manifest = {"identity": key, "root": str(self.root), "tools": str(tools)}
        (generation / "manifest.json").write_text(json.dumps(manifest))
        (state / "current").symlink_to(generation.name)
        self.assertEqual(module.selected(state, self.root, key), (generation, tools))
        self.assertIsNone(module.selected(state, self.root, "different"))
        (generation / "manifest.json").write_text("{broken")
        self.assertIsNone(module.selected(state, self.root, key))
        (generation / "tools").unlink()
        self.assertIsNone(module.selected(state, self.root, key))


if __name__ == "__main__":
    unittest.main()
