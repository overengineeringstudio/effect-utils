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
        self.tools = Path(os.environ["WORKTREE_TEST_TOOLS"]).resolve(strict=True)
        # Synthetic Git repositories must not inherit operator hooks, signing or
        # other global/system configuration. Keep this isolation fixture-owned.
        config = tempfile.NamedTemporaryFile(dir=os.environ["TMPDIR"])
        self.addCleanup(config.close)
        overrides = {"GIT_CONFIG_GLOBAL": config.name, "GIT_CONFIG_NOSYSTEM": "1"}
        previous = {name: os.environ.get(name) for name in overrides}

        def restore_git_config():
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        self.addCleanup(restore_git_config)
        os.environ.update(overrides)
        os.chdir(self.root)
        subprocess.run(["git", "init", "-q"], check=True)
        (self.root / ".gitignore").write_text(".worktree-tools/\n")
        (self.root / "flake.nix").write_text("before\n")
        (self.root / "flake.lock").write_text("{}\n")
        (self.root / "nix").mkdir()
        (self.root / "nix/fixture.nix").write_text("{}\n")
        (self.root / "scripts").mkdir()
        (self.root / "scripts/fixture.unit.test.ts").write_text("// check-only\n")
        subprocess.run(["git", "add", "."], check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], check=True)

    def tearDown(self):
        os.chdir(self.previous)
        self.scratch.cleanup()

    def publish(self):
        state = self.root / ".worktree-tools/v2"
        generation = state / "generation-fixture"
        generation.mkdir(parents=True)
        (generation / "tools").symlink_to(self.tools)
        manifest = {
            "identity": module.identity(self.root, self.tools),
            "root": str(self.root), "tools": str(self.tools),
        }
        (generation / "manifest.json").write_text(json.dumps(manifest))
        (state / "current").symlink_to(generation.name)
        return state, generation

    def test_staged_and_unstaged_identity(self):
        before = module.identity(self.root, self.tools)
        (self.root / "flake.nix").write_text("after\n")
        after = module.identity(self.root, self.tools)
        self.assertNotEqual(before, after)
        subprocess.run(["git", "add", "flake.nix"], check=True)
        self.assertEqual(after, module.identity(self.root, self.tools))
        (self.root / "nix/new-source.nix").write_text("new\n")
        self.assertNotEqual(after, module.identity(self.root, self.tools))
        with self.assertRaisesRegex(RuntimeError, "Stage new source") as refused:
            module.source_snapshot(self.root)
        self.assertIn('paths=["nix/new-source.nix"]', str(refused.exception))

    def test_untracked_diagnostic_is_bounded_and_escaped(self):
        names = [f"new-{index:02}" + ("\n\x1b" if index == 0 else "") for index in range(12)]
        for name in names:
            (self.root / name).write_text("new\n")
        with self.assertRaisesRegex(RuntimeError, "Stage new source") as refused:
            module.source_snapshot(self.root)
        message = str(refused.exception)
        self.assertIn(f"paths={json.dumps(names[:10])}; limit=10", message)
        self.assertNotIn(json.dumps(names[10]), message)
        self.assertNotIn("\n", message)
        self.assertNotIn("\x1b", message)

    def test_ordinary_clone_cas_is_runtime_state_not_source(self):
        (self.root / ".gitignore").write_text(Path(os.environ["WORKTREE_TEST_GITIGNORE"]).read_text())
        subprocess.run(["git", "add", ".gitignore"], check=True)
        before = module.identity(self.root, self.tools)
        cas = self.root / ".editor-view-content"
        (cas / "v1" / "00").mkdir(parents=True)
        (cas / "v1.flock").write_text("lease\n")
        (cas / "v1" / "00" / "digest-0444").write_text("blob\n")
        self.assertEqual(before, module.identity(self.root, self.tools))
        (self.root / "new-source.ts").write_text("export {}\n")
        with self.assertRaisesRegex(RuntimeError, "new-source.ts"):
            module.source_snapshot(self.root)

    def test_immutable_selection_and_stale_manifest(self):
        state, generation = self.publish()
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))
        (self.root / "flake.nix").write_text("different\n")
        self.assertIsNone(module.selected(state, self.root))
        (self.root / "flake.nix").write_text("before\n")
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))
        (generation / "manifest.json").write_text("{broken")
        self.assertIsNone(module.selected(state, self.root))
        (generation / "tools").unlink()
        self.assertIsNone(module.selected(state, self.root))

    def test_manifest_authenticates_identity_root_and_tool_closure(self):
        state, generation = self.publish()
        path = generation / "manifest.json"
        manifest = json.loads(path.read_text())
        for field in ("identity", "root", "tools"):
            with self.subTest(field=field):
                path.write_text(json.dumps({**manifest, field: "different"}))
                self.assertIsNone(module.selected(state, self.root))
        path.write_text(json.dumps(manifest))
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))

    def test_check_only_comment_keeps_tools_selected(self):
        state, generation = self.publish()
        before = module.source_snapshot(self.root)
        (self.root / "scripts/fixture.unit.test.ts").write_text("// edited check-only comment\n")
        self.assertNotEqual(before, module.source_snapshot(self.root))
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))
        subprocess.run(["git", "add", "scripts/fixture.unit.test.ts"], check=True)
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))
        (self.root / "scripts/new-fixture.unit.test.ts").write_text("// new check-only\n")
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))

    def test_source_only_commit_keeps_tools_selected(self):
        state, generation = self.publish()
        before = module.source_snapshot(self.root)
        (self.root / "scripts/fixture.unit.test.ts").write_text("// committed check-only comment\n")
        subprocess.run(["git", "add", "scripts/fixture.unit.test.ts"], check=True)
        subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "-qm", "source-only"], check=True)
        self.assertNotEqual(before, module.source_snapshot(self.root))
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))

    def test_nix_and_lockfile_changes_make_tools_stale(self):
        state, generation = self.publish()
        for name in ("nix/fixture.nix", "flake.lock"):
            with self.subTest(path=name):
                path = self.root / name
                before = path.read_text()
                path.write_text(before + "# changed\n")
                self.assertIsNone(module.selected(state, self.root))
                path.write_text(before)
                self.assertEqual(module.selected(state, self.root), (generation, self.tools))

    def test_selected_membership_changes_make_tools_stale(self):
        state, generation = self.publish()
        addition = self.root / "nix/new-source.nix"
        addition.write_text("{}\n")
        self.assertIsNone(module.selected(state, self.root))
        subprocess.run(["git", "add", "nix/new-source.nix"], check=True)
        self.assertIsNone(module.selected(state, self.root))
        addition.unlink()
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))
        (self.root / "nix/fixture.nix").unlink()
        self.assertIsNone(module.selected(state, self.root))

    def test_meaningful_modes_and_symlink_targets_change_identity(self):
        state, generation = self.publish()
        path = self.root / "nix/fixture.nix"
        mode = path.stat().st_mode
        path.chmod(0o600)
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))
        path.chmod(0o700)
        self.assertIsNone(module.selected(state, self.root))
        path.chmod(mode)
        self.assertEqual(module.selected(state, self.root), (generation, self.tools))
        path.unlink()
        path.symlink_to("../flake.nix")
        symlink_identity = module.identity(self.root, self.tools)
        self.assertIsNone(module.selected(state, self.root))
        path.unlink()
        path.symlink_to("../flake.lock")
        self.assertNotEqual(symlink_identity, module.identity(self.root, self.tools))

    def test_owning_root_is_part_of_identity(self):
        before = module.identity(self.root, self.tools)
        with tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"]) as directory:
            other = Path(directory).resolve()
            subprocess.run(["git", "clone", "-q", str(self.root), str(other)], check=True)
            self.assertNotEqual(before, module.identity(other, self.tools))

    def test_v1_publication_is_not_selected_in_v2(self):
        state, generation = self.publish()
        legacy = self.root / ".worktree-tools/v1"
        state.rename(legacy)
        self.assertIsNone(module.selected(state, self.root))


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


class BridgeIdentity(unittest.TestCase):
    def test_real_native_help_consumes_only_explicit_caller_identity(self):
        for explicit in (False, True):
            with self.subTest(explicit=explicit), tempfile.TemporaryDirectory(
                dir=os.environ["TMPDIR"]
            ) as directory:
                root = Path(directory)
                environment = dict(os.environ)
                environment.pop("PIPELINE_SPOOL_DIR", None)
                environment.pop("BUCK2_CALLER_UUID", None)
                environment.update({
                    "WORKSPACE_ROOT": directory,
                    "BUCK_WRAPPER_UUID": BuckIdentity.caller_uuid,
                    "TRACEPARENT": BuckIdentity.context,
                    "OTEL_TASK_TRACEPARENT": BuckIdentity.context,
                    "OTEL_SPAN_SPOOL_DIR": str(root / "spans"),
                    "OTEL_EXPORTER_OTLP_ENDPOINT": "",
                    "OTELITE_HTTP_ENDPOINT": "",
                    "XDG_STATE_HOME": str(root / "state"),
                })
                if explicit:
                    environment["BUCK2_CALLER_UUID"] = BuckIdentity.caller_uuid
                result = subprocess.run(
                    [os.environ["WORKTREE_TEST_BRIDGE"], "--isolation-dir",
                     "wrapper-identity", "build", "--help"],
                    env=environment, text=True, capture_output=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                sidecars = list((root / ".worktree-tools/otel/buck2").glob("*.sidecar"))
                self.assertEqual(len(sidecars), 1)
                invocation = sidecars[0].read_text().split(" ", 1)[0]
                if explicit:
                    self.assertEqual(invocation, BuckIdentity.caller_uuid)
                else:
                    self.assertNotEqual(invocation, BuckIdentity.caller_uuid)
                    self.assertEqual(str(uuid.UUID(invocation)), invocation)


if __name__ == "__main__":
    unittest.main()
