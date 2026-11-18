"""Real Git/closure and installed tracing-helper identity fixtures."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest
import uuid

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

    def test_policy_paths_capture_only_named_immutable_tools(self):
        tools = Path(os.environ["WORKTREE_TEST_TOOLS"]).resolve(strict=True)
        caller = self.root / "caller-bin"
        caller.mkdir()
        (caller / "buck2").symlink_to(tools / "bin/buck2")
        guards = str(self.root / "agent-seat/policy-bin")
        selected = module.policy_paths([guards, str(caller)], ["buck2"])
        self.assertEqual(selected, [guards, str((tools / "bin/buck2").resolve().parent)])
        self.assertNotIn(str(caller), selected)

    def test_policy_paths_do_not_forward_ambient_tools_or_missing_commands(self):
        caller = self.root / "caller-bin"
        caller.mkdir()
        (caller / "gate-slot").touch(mode=0o755)
        guards = str(self.root / "agent-seat/policy-bin")
        self.assertEqual(
            module.policy_paths([guards, str(caller)], ["gate-slot", "absent"]), [guards]
        )

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


class BuckIdentity(unittest.TestCase):
    caller_uuid = "12345678-1234-1234-1234-123456789abc"
    trace_id = "1" * 32
    context = "00-" + trace_id + "-" + "2" * 16 + "-01"

    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"])
        self.addCleanup(self.scratch.cleanup)
        self.sidecar = Path(self.scratch.name) / "command.sidecar"

    def prepare(self, args=(), context=""):
        environment = dict(os.environ)
        environment.pop("OTEL_TASK_TRACEPARENT", None)
        environment.pop("TRACEPARENT", None)
        environment["BUCK_WRAPPER_UUID"] = self.caller_uuid
        if context:
            environment["TRACEPARENT"] = context
        return subprocess.run([os.environ["WORKTREE_TEST_OTEL"], "buck2", "--sidecar",
                               str(self.sidecar), *args], env=environment,
                              text=True, capture_output=True)

    def test_supplied_uuid_joins_existing_sidecar_authority(self):
        result = self.prepare(("--uuid", self.caller_uuid), self.context)
        self.assertEqual(result.returncode, 0, result.stderr)
        span_id = re.search(r"BUCK_COMMAND_SPAN_ID=([0-9a-f]{16})", result.stdout).group(1)
        self.assertIn("BUCK_WRAPPER_UUID=" + self.caller_uuid, result.stdout)
        self.assertEqual(self.sidecar.read_text(),
                         f"{self.caller_uuid} 00-{self.trace_id}-{span_id}-01\n")

    def test_supplied_uuid_survives_absent_or_invalid_context(self):
        for context in ("", "invalid", "00-" + "0" * 32 + "-" + "2" * 16 + "-01"):
            with self.subTest(context=context):
                result = self.prepare(("--uuid", self.caller_uuid), context)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("export BUCK_WRAPPER_UUID=" + self.caller_uuid, result.stdout)
                self.assertIn("unset BUCK_COMMAND_TRACE_ID", result.stdout)
                self.assertFalse(self.sidecar.exists())

    def test_omitted_uuid_retains_derived_identity_contract(self):
        result = self.prepare(context=self.context)
        self.assertEqual(result.returncode, 0, result.stderr)
        span_id = re.search(r"BUCK_COMMAND_SPAN_ID=([0-9a-f]{16})", result.stdout).group(1)
        expected = str(uuid.UUID(hex=hashlib.sha256(f"{self.trace_id}:{span_id}".encode()).hexdigest()[:32]))
        self.assertIn("BUCK_WRAPPER_UUID=" + expected, result.stdout)
        self.assertEqual(self.sidecar.read_text(), f"{expected} 00-{self.trace_id}-{span_id}-01\n")

    def test_omitted_uuid_clears_inherited_identity_without_context(self):
        result = self.prepare()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("unset BUCK_WRAPPER_UUID", result.stdout)
        self.assertFalse(self.sidecar.exists())

    def test_noncanonical_uuid_is_rejected_before_sidecar_write(self):
        result = self.prepare(("--uuid", "not-a-uuid"), self.context)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires a canonical UUID", result.stderr)
        self.assertFalse(self.sidecar.exists())


if __name__ == "__main__":
    unittest.main()
