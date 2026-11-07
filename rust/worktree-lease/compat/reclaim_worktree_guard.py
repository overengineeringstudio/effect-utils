"""Temporary guard import; native-backed scope and eligibility only."""
import importlib.util
from pathlib import Path
_spec = importlib.util.spec_from_file_location('native_lease_bridge', Path(__file__).with_name('gate_worktree_lease.py'))
LEASE = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(LEASE)
dead_expired, guard_git_dir, guard_main, lease_lock = (LEASE.dead_expired, LEASE.guard_git_dir, LEASE.guard_main, LEASE.lease_lock)

if __name__ == '__main__':
    raise SystemExit(guard_main())
