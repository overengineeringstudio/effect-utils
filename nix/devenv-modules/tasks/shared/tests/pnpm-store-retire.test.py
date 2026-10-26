"""Filesystem integration coverage. Every mutation is confined to a temporary fixture."""

import contextlib
import fcntl
import importlib.util
import json
import io
import os
from pathlib import Path
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SHARED = Path(__file__).resolve().parents[1]
ROOT = SHARED.parents[3]
SPEC = importlib.util.spec_from_file_location("retirement", SHARED / "pnpm-store-retire.py")
ENGINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ENGINE)

def run_bounded_command(command, name, timeout, env=None):
    child = subprocess.Popen(command, env=env, start_new_session=True)
    try:
        return child.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Kill the whole test session, including a shell/flock descendant that
        # could otherwise retain a lease or an inherited output pipe.
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        print(f"FAIL: {name} exceeded its {timeout}s deadline; process group killed",
              file=sys.stderr, flush=True)
        return 124



class RetirementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pnpm-retire-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.worktrees = self.base / "home/.megarepo/github.com/fixture"
        self.repo = self.worktrees / "repo"
        self.repo.mkdir(parents=True)
        self.bin = self.base / "bin"
        self.bin.mkdir()
        for name in ("bash", "git", "flock", "mkdir", "node"):
            executable = shutil.which(name)
            if executable is None:
                self.fail(f"required fixture tool is missing: {name}")
            (self.bin / name).symlink_to(executable)
        self.env = dict(os.environ, HOME=str(self.base / "home"), PATH=str(self.bin))
        for key in list(self.env):
            if key.startswith("PNPM_") or key.startswith("_PNPM_RETIRE_") or key.startswith("GIT_"):
                del self.env[key]
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
        self.git("init", "--quiet")
        self.git("-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "--allow-empty", "--quiet", "-m", "fixture")
        self.store = self.base / "old-store"
        self.make_store(self.store)

    def git(self, *args):
        result = subprocess.run([str(self.bin / "git"), "-C", str(self.repo), *args], env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(result.returncode, 0, os.fsdecode(result.stderr))
        return result

    def make_store(self, path):
        (path / "v11/files/aa").mkdir(parents=True)
        (path / "v11/files/aa/payload").write_text("preserved payload\n")

    def cli(self, *args, extra_env=None, target=True):
        env = dict(self.env, **(extra_env or {}))
        argv = [sys.executable, str(SHARED / "pnpm-store-retire.py"), str(ROOT / "pnpm-install-contract.json"), str(SHARED / "pnpm-task-helpers.sh")]
        if target:
            argv.append(str(self.store))
        return subprocess.run([*argv, *args], env=env, cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def refused(self, result, reason):
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(reason, result.stderr)
        self.assertEqual((self.store / "v11/files/aa/payload").read_text(), "preserved payload\n")

    def mr(self, document=None, script=None):
        path = self.bin / "mr"
        if script is None:
            script = f"printf '%s\\n' '{json.dumps(document)}'"
        path.write_text(f"#!{shutil.which('bash')}\nset -eu\n{script}\n")
        path.chmod(0o755)

    def test_dry_run_and_explicit_target(self):
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["verdict"], "eligible")
        self.assertEqual(report["mode"], "dry-run")
        self.assertGreater(report["bytes"], 0)
        self.assertTrue(self.store.is_dir())
        self.assertNotEqual(self.cli(target=False).returncode, 0)
        self.assertEqual(self.cli(target=False, extra_env={"PNPM_RETIRE_STORE_DIR": str(self.store)}).returncode, 0)

    def test_apply(self):
        result = self.cli("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["verdict"], "retired")
        self.assertFalse(self.store.exists())
        self.assertEqual(list(self.base.glob("old-store.retired-*")), [])

    def test_environment_confirmation_is_exact(self):
        for value in ("0", "true", "yes", "2"):
            result = self.cli(extra_env={"PNPM_RETIRE_APPLY": value})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["mode"], "dry-run")
        result = self.cli(extra_env={"PNPM_RETIRE_APPLY": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.store.exists())

    def test_shared_contract_and_configured_stores(self):
        contract = json.loads((ROOT / "pnpm-install-contract.json").read_text())
        default = contract["storeContract"]["localDevelopment"]["defaultPath"]
        shared = Path(default.replace("~", self.env["HOME"], 1))
        self.make_store(shared)
        self.refused(self.cli(str(shared), target=False), "protected shared store")
        for selected in (self.store, self.store.parent, self.store / "v11/files"):
            self.refused(self.cli(extra_env={"PNPM_SHARED_STORE_DIR": str(selected)}), "protected shared store")
        alias = self.base / "shared-alias"
        alias.symlink_to(self.store, target_is_directory=True)
        self.refused(self.cli(extra_env={"PNPM_SHARED_STORE_DIR": str(alias)}), "protected shared store")

    def test_non_store_and_layout_symlinks(self):
        unknown = self.base / "unknown"
        unknown.mkdir()
        result = self.cli(str(unknown), target=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((unknown / ENGINE.LEASE).exists())
        files = self.store / "v11/files"
        external = self.base / "external-files"
        files.rename(external)
        files.symlink_to(external, target_is_directory=True)
        self.assertNotEqual(self.cli().returncode, 0)
        self.assertTrue((external / "aa/payload").exists())

    def test_unused_gvs_internal_relative_and_absolute_symlinks_apply(self):
        modules = self.store / "v11/links/package/node_modules"
        modules.mkdir(parents=True)
        (modules / "relative").symlink_to("../../../files/aa", target_is_directory=True)
        (modules / "absolute").symlink_to(self.store / "v11/files/aa", target_is_directory=True)
        result = self.cli("--apply")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.store.exists())

    def test_internal_layout_symlink_refused(self):
        (self.store / "v11/index").symlink_to(self.base)
        self.refused(self.cli(), "layout contains a symlink")

    def test_symlinked_workspace_package_is_scanned(self):
        package = self.base / "linked-package"
        (package / "node_modules").mkdir(parents=True)
        (package / "node_modules/dependency").symlink_to(self.store / "v11/files", target_is_directory=True)
        (self.repo / "workspace-package").symlink_to(package, target_is_directory=True)
        self.refused(self.cli(), "consumer symlink")

    def test_workspace_symlink_and_gvs_projection(self):
        modules = self.repo / "packages/example/node_modules"
        modules.mkdir(parents=True)
        (modules / ".pnpm").symlink_to(self.store / "v11/files", target_is_directory=True)
        self.refused(self.cli(), "consumer symlink")

    def test_dangling_symlink_and_scan_error(self):
        modules = self.repo / "node_modules"
        modules.mkdir()
        (modules / "dangling").symlink_to(self.store / "missing-package")
        self.refused(self.cli(), "cannot resolve symlink")

    def test_known_and_unknown_hardlinks(self):
        modules = self.repo / "packages/example/node_modules/package"
        modules.mkdir(parents=True)
        os.link(self.store / "v11/files/aa/payload", modules / "payload")
        self.refused(self.cli(), "consumer hardlink")
        (modules / "payload").unlink()
        os.link(self.store / "v11/files/aa/payload", self.base / "unknown-consumer")
        self.refused(self.cli(), "unidentified external hardlinks")

    def test_internal_hardlinks_are_counted(self):
        os.link(self.store / "v11/files/aa/payload", self.store / "v11/files/internal-alias")
        self.assertEqual(self.cli().returncode, 0)

    def test_external_gvs_hardlink(self):
        gvs = self.base / "external-gvs"
        gvs.mkdir()
        os.link(self.store / "v11/files/aa/payload", gvs / "payload")
        (self.repo / "node_modules").symlink_to(gvs, target_is_directory=True)
        self.refused(self.cli(), "consumer hardlink")

    def test_every_offending_root_is_reported_even_when_roots_overlap(self):
        second = self.repo / "nested-worktree"
        self.git("worktree", "add", "--quiet", "--detach", str(second))
        for root in (self.repo, second):
            (root / "node_modules").symlink_to(self.store / "v11/files", target_is_directory=True)
        result = self.cli()
        self.refused(result, "consumer symlink")
        report = json.loads(result.stderr)
        self.assertEqual({item["root"] for item in report["offendingRoots"]}, {str(self.repo), str(second)})

    def test_all_current_git_worktrees(self):
        second = self.worktrees / "second checkout with spaces"
        self.git("worktree", "add", "--quiet", "--detach", str(second))
        (second / "node_modules").symlink_to(self.store / "v11/files", target_is_directory=True)
        self.refused(self.cli(), "consumer symlink")

    def test_all_mr_git_worktrees_and_supported_json(self):
        bare = self.base / "mr-store/example/repository/.bare"
        bare.parent.mkdir(parents=True)
        self.git("clone", "--quiet", "--bare", str(self.repo), str(bare))
        checkout = self.worktrees / "unusual mr checkout"
        subprocess.run([str(self.bin / "git"), "--git-dir", str(bare), "worktree", "add", "--quiet", "--detach", str(checkout)], check=True, env=self.env)
        modules = checkout / "packages/example/node_modules"
        modules.mkdir(parents=True)
        (modules / "dependency").symlink_to(self.store / "v11/files", target_is_directory=True)
        self.mr({"_tag": "Ls", "basePath": str(self.base / "mr-store"), "repos": [{"relativePath": "example/repository"}]})
        self.refused(self.cli(), "consumer symlink")

    def test_mr_errors_and_unknown_json_fail_closed(self):
        for document in ({}, {"_tag": "Ls", "basePath": str(self.base), "repos": [{"relativePath": "../escape"}]}, {"_tag": "Ls", "basePath": str(self.base), "repos": [{"relativePath": "missing"}]}):
            self.mr(document)
            self.assertNotEqual(self.cli().returncode, 0)
        self.mr(script="exit 7")
        self.refused(self.cli(), "enumeration failed")

    def test_prunable_registered_worktree_fails_closed(self):
        second = self.worktrees / "missing-worktree"
        self.git("worktree", "add", "--quiet", "--detach", str(second))
        shutil.rmtree(second)
        self.refused(self.cli(), "prunable")

    def test_real_exclusive_helper_lease_covers_enumeration(self):
        document = {"_tag": "Ls", "basePath": str(self.base), "repos": []}
        self.mr(script=f"if flock --shared --nonblock '{self.store / ENGINE.LEASE}' -c ':'; then exit 9; fi\nprintf '%s\\n' '{json.dumps(document)}'")
        result = self.cli()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_lease_is_private_regular_file(self):
        outside = self.base / "outside-lock"
        outside.write_text("do not truncate")
        (self.store / ENGINE.LEASE).symlink_to(outside)
        self.assertNotEqual(self.cli().returncode, 0)
        self.assertEqual(outside.read_text(), "do not truncate")

    @contextlib.contextmanager
    def leased(self):
        with patch.dict(os.environ, self.env, clear=True), contextlib.chdir(self.repo):
            lock = os.open(self.store / ENGINE.LEASE, os.O_RDWR | os.O_CREAT, 0o600)
            try:
                os.dup2(lock, 202)
                fcntl.flock(202, fcntl.LOCK_EX)
                yield ENGINE.identity(self.store.stat())
            finally:
                os.close(202)
                os.close(lock)

    def test_lock_replacement_is_refused(self):
        with self.leased() as root:
            (self.store / ENGINE.LEASE).unlink()
            (self.store / ENGINE.LEASE).touch()
            with self.assertRaisesRegex(ENGINE.Refusal, "lease pathname/inode changed"):
                ENGINE.retire(self.store, True, root)
        self.assertTrue(self.store.is_dir())

    def test_scan_error_fails_closed(self):
        modules = self.repo / "node_modules"
        modules.mkdir()
        original = os.scandir
        def deny(path):
            if Path(path) == modules:
                raise PermissionError("fixture scan denied")
            return original(path)
        with self.leased() as root, patch.object(ENGINE.os, "scandir", deny):
            with self.assertRaisesRegex(ENGINE.Refusal, "fixture scan denied"):
                ENGINE.retire(self.store, True, root)
        self.assertTrue(self.store.is_dir())

    def test_target_replacement_before_rename_is_not_deleted(self):
        original = os.rename
        def replace(source, destination, **kwargs):
            original(source, "proved-store", **kwargs)
            self.make_store(self.store)
            original(source, destination, **kwargs)
        with self.leased() as root, patch.object(ENGINE.os, "rename", replace):
            with self.assertRaisesRegex(ENGINE.Refusal, "not the proved store"):
                ENGINE.retire(self.store, True, root)
        self.assertTrue((self.base / "proved-store/v11/files/aa/payload").exists())
        self.assertEqual(len(list(self.base.glob("old-store.retired-*/v11/files/aa/payload"))), 1)

    def test_exclusive_lease_is_held_through_removal(self):
        original = shutil.rmtree
        def remove(path, **kwargs):
            descriptor = os.open(self.base / path / ENGINE.LEASE, os.O_RDONLY)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(descriptor, fcntl.LOCK_SH | fcntl.LOCK_NB)
            finally:
                os.close(descriptor)
            original(path, **kwargs)
            os.fstat(202)
        remove.avoids_symlink_attacks = original.avoids_symlink_attacks
        with self.leased() as root, patch.object(ENGINE.shutil, "rmtree", remove):
            ENGINE.retire(self.store, True, root)
        self.assertFalse(self.store.exists())

    def test_waiting_installer_reopens_retired_lease_inode(self):
        script = '''
set -euo pipefail
source "$1"
queued_flock() { printf 'queued\\n'; flock "$@"; }
acquire_pnpm_store_cache_lease queued_flock shared "$2" 5
node - "$2/.effect-utils-pnpm-store-cache-maintenance.lock" <<'JS'
const fs = require('node:fs')
const held = fs.fstatSync(202, { bigint: true })
const current = fs.statSync(process.argv[2], { bigint: true })
process.exit(held.dev === current.dev && held.ino === current.ino ? 0 : 1)
JS
printf 'acquired\\n'
'''
        waiter = None
        stale_lock = None
        try:
            with self.leased() as root:
                original_lock = ENGINE.identity((self.store / ENGINE.LEASE).stat())
                stale_lock = os.open(self.store / ENGINE.LEASE, os.O_RDONLY)
                waiter = subprocess.Popen(
                    [str(self.bin / "bash"), "-c", script, "installer",
                     str(SHARED / "pnpm-task-helpers.sh"), str(self.store)],
                    env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                    text=True,
                )
                readable, _, _ = select.select([waiter.stdout], [], [], 5)
                self.assertTrue(readable, "installer did not queue for the held lease")
                self.assertEqual(waiter.stdout.readline(), "queued\n")
                self.assertIsNone(waiter.poll(), "installer bypassed the exclusive lease")
                ENGINE.retire(self.store, True, root)
                self.assertFalse(self.store.exists())
            stdout, stderr = waiter.communicate(timeout=10)
            self.assertEqual(waiter.returncode, 0, stderr)
            self.assertEqual(stdout, "queued\nacquired\n")
            self.assertNotEqual(
                ENGINE.identity((self.store / ENGINE.LEASE).stat()), original_lock,
            )
        finally:
            if waiter is not None and waiter.poll() is None:
                waiter.kill()
                waiter.communicate()
            if stale_lock is not None:
                os.close(stale_lock)

    def test_target_recreation_keeps_tombstone_and_new_target(self):
        original = os.rename
        def recreate(*args, **kwargs):
            original(*args, **kwargs)
            self.store.mkdir()
            (self.store / "new-live-file").write_text("new store")
        with self.leased() as root, patch.object(ENGINE.os, "rename", recreate):
            with self.assertRaisesRegex(ENGINE.Refusal, "recreated"):
                ENGINE.retire(self.store, True, root)
        self.assertEqual((self.store / "new-live-file").read_text(), "new store")
        self.assertEqual(len(list(self.base.glob("old-store.retired-*/v11/files/aa/payload"))), 1)

    def test_interruption_keeps_tombstone(self):
        with self.leased() as root, patch.object(ENGINE.shutil, "rmtree", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                ENGINE.retire(self.store, True, root)
        self.assertFalse(self.store.exists())
        self.assertEqual(len(list(self.base.glob("old-store.retired-*/v11/files/aa/payload"))), 1)

    def test_post_rename_symlink_change_keeps_tombstone(self):
        (self.store / "v11/internal-link").symlink_to("files/aa")
        original = os.rename
        def change_link(source, destination, **kwargs):
            original(source, destination, **kwargs)
            link = self.base / destination / "v11/internal-link"
            link.unlink()
            link.symlink_to(self.repo)
        with self.leased() as root, patch.object(ENGINE.os, "rename", change_link):
            with self.assertRaisesRegex(ENGINE.Refusal, "changed after retirement rename"):
                ENGINE.retire(self.store, True, root)
        self.assertEqual(len(list(self.base.glob("old-store.retired-*/v11/files/aa/payload"))), 1)
        self.assertTrue(self.repo.is_dir())

    def test_post_rename_hardlink_change_keeps_tombstone(self):
        original = os.rename
        def link_after_rename(source, destination, **kwargs):
            original(source, destination, **kwargs)
            os.link(self.base / destination / "v11/files/aa/payload", self.base / "new-consumer")
        with self.leased() as root, patch.object(ENGINE.os, "rename", link_after_rename):
            with self.assertRaisesRegex(ENGINE.Refusal, "external hardlinks"):
                ENGINE.retire(self.store, True, root)
        self.assertTrue((self.base / "new-consumer").exists())
        self.assertEqual(len(list(self.base.glob("old-store.retired-*/v11/files/aa/payload"))), 1)

    def test_watchdog_names_and_kills_blocked_test(self):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            status = run_bounded_command(
                [sys.executable, "-c", "import signal; signal.pause()"],
                "blocked-fixture", 0.1,
            )
        self.assertEqual(status, 124)
        self.assertIn("blocked-fixture", output.getvalue())
        self.assertIn("process group killed", output.getvalue())


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--case":
        unittest.main(argv=[sys.argv[0], sys.argv[2]], verbosity=2)
    else:
        names = unittest.defaultTestLoader.getTestCaseNames(RetirementTests)
        for name in names:
            qualified = f"RetirementTests.{name}"
            print(f"pnpm-store-retire: test={qualified} deadline=30s", flush=True)
            # The supervisor owns this directory, so even a killed test's
            # temporary stores are reclaimed only after all descendants die.
            with tempfile.TemporaryDirectory(prefix="pnpm-retire-case-") as fixture:
                status = run_bounded_command(
                    [sys.executable, __file__, "--case", qualified],
                    qualified, 30, dict(os.environ, TMPDIR=fixture),
                )
            if status:
                sys.exit(status)
        print(f"All {len(names)} bounded pnpm store retirement tests passed", flush=True)
