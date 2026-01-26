# Megarepo Stress Test Report

**Date:** 2026-01-26
**Tester:** Claude Code
**Version:** 0.1.0
**Environment:** Linux (Ubuntu-based container without SSH/nix/devenv)

## Executive Summary

Megarepo is a well-designed multi-repository management tool with a solid architecture. The core functionality works well, but several bugs, design issues, and spec/implementation gaps were identified during testing.

**Overall Assessment:** Good foundation, needs polish before production use.

| Category | Count |
|----------|-------|
| Bugs | 7 |
| Design Issues | 2 |
| Spec/Implementation Gaps | 3 |
| Tests Passing | 248/249 (99.6%) |

---

## Bugs Found

### Bug #1: CLI Argument Order Sensitivity
**Severity:** Low
**Component:** CLI (add command)

**Description:**
Optional flags like `--name` fail when placed AFTER positional arguments:
```bash
# Fails with "Received unknown argument: '--name'"
mr add effect-ts/effect#v3.15.0 --name effect-v3

# Works
mr add --name effect-v3 effect-ts/effect#v3.15.0
mr add -n effect-v3 effect-ts/effect#v3.15.0
```

**Impact:** Confusing error message; users expect standard POSIX flag ordering flexibility.

**Recommendation:** Either fix @effect/cli to allow trailing options, or document the requirement clearly.

---

### Bug #2: Poor Error Messages for Non-Existent Refs
**Severity:** Medium
**Component:** sync

**Description:**
When a tag/branch doesn't exist, the error shows raw git output:
```
error: fatal: ambiguous argument 'v1.0.0': unknown revision or path not in the working tree.
```

**Expected:** A user-friendly message like:
```
error: Ref 'v1.0.0' not found in repository https://github.com/owner/repo
  hint: Check available tags with: git ls-remote --tags <url>
```

**Impact:** Users need git knowledge to understand the error.

---

### Bug #3: Race Condition When Syncing Multiple Refs of Same Repo
**Severity:** Medium
**Component:** sync (concurrent operations)

**Description:**
When syncing multiple members from the same underlying repository (e.g., `jq-latest` and `jq-v16` both from `jqlang/jq`), a race condition occurs on first sync:

```
✗ jq-latest error: fatal: destination path '.bare' already exists
✓ jq-v16 cloned
```

**Cause:** Parallel sync operations both try to clone the bare repo simultaneously.

**Workaround:** Running `mr sync --pull` again succeeds (existing bare repo is reused).

**Recommendation:** Add mutex/lock around bare repo creation per repository URL.

---

### Bug #4: Tags Misclassified as Branches
**Severity:** Medium
**Component:** lib/ref.ts

**Description:**
Tag detection heuristic only matches semver patterns (`v1.0.0`, `1.0`). Non-semver tags are classified as branches:

```
# Tag jq-1.6 stored as branch
jq-v16 -> /root/.megarepo/github.com/jqlang/jq/refs/heads/jq-1.6  # WRONG
# Should be
jq-v16 -> /root/.megarepo/github.com/jqlang/jq/refs/tags/jq-1.6   # CORRECT
```

**Impact:** Tags like `release-v1`, `beta-2024`, `stable` are treated as mutable branches.

**Recommendation:** Query remote to determine actual ref type, or add explicit `#tag:name` / `#branch:name` syntax as spec notes.

---

### Bug #5: Pin Command Doesn't Update Worktree Path
**Severity:** Low
**Component:** pin command

**Description:**
According to spec, pinned members should use commit-based worktree paths (`refs/commits/<sha>/`). However, `mr pin` only sets `pinned: true` in lock file without updating the symlink:

```bash
mr pin hello
# Lock shows pinned: true, but symlink still points to refs/heads/master
# Expected: symlink should point to refs/commits/7fd1a60.../
```

**Impact:** Pinned members aren't fully isolated from branch changes.

**Workaround:** Use `mr sync --frozen` which correctly uses commit-based paths.

---

### Bug #6: Store GC Only Considers Current Megarepo
**Severity:** Medium
**Component:** store gc

**Description:**
`mr store gc` identifies worktrees as "unused" if they're not referenced by the current megarepo's lock file, even if other megarepos are using them:

```bash
# In megarepo-test (uses hello via refs/heads/master)
mr store gc --dry-run
# Shows: refs/commits/7fd1a60... (would remove)
# But megarepo-frozen-test is using that commit worktree!
```

**Impact:** Running gc from one megarepo can delete worktrees needed by others.

**Recommendation:** Document this clearly, or scan all megarepos in known locations.

---

### Bug #7: Integration Test Environment Sensitivity
**Severity:** Low
**Component:** tests

**Description:**
Test `sync error handling > should return clear error when remote repo does not exist` fails because error messages vary by environment:

- Test expects: 'clone', 'repository', 'not found', or 'access'
- Got: "fatal: could not read Username for 'https://github.com'"

**Impact:** Tests fail in environments without SSH configured.

**Recommendation:** Make error message assertions more flexible or mock git operations.

---

## Design Issues

### Design Issue #1: Tag Detection Heuristic Too Narrow
**Component:** lib/ref.ts (classifyRef, looksLikeTag)

**Current Behavior:**
Only matches semver-like patterns: `/^v?\d+\.\d+(\.\d+)?/`

**Problem:**
Many valid tags don't match this pattern:
- `jq-1.6`, `release-v1.0`, `beta-2024.01.01`
- `stable`, `latest`, `production`

**Impact:** These tags are stored in `refs/heads/` instead of `refs/tags/`, affecting:
1. Store organization (path no longer reveals true type)
2. Immutability expectations (branches are mutable)

**Recommendations:**
1. Query remote with `git ls-remote --refs` to determine actual type
2. Add explicit syntax: `owner/repo#tag:name`, `owner/repo#branch:name`
3. Document the limitation clearly

---

### Design Issue #2: Spec/Implementation Gaps
**Several documented features are not implemented:**

| Feature | Spec Says | Actual |
|---------|-----------|--------|
| `mr store add <repo>` | Add repo to store without adding to megarepo | Not implemented |
| `mr exec --mode parallel\|sequential\|topo` | Execution mode control | Not implemented |
| `--verbose / -v` | Common option for all commands | Not implemented |
| Pin uses commit paths | Pinned members use commit-based paths | Only lock file updated |

**Impact:** Documentation promises features that don't exist yet.

**Recommendation:** Either implement or remove from spec.

---

## Positive Findings

### What Works Well

1. **Core Sync Flow**: Default sync, `--pull`, and `--frozen` modes all work correctly
2. **Store Architecture**: Bare repo + worktrees design is elegant and efficient
3. **Frozen Mode**: Excellent CI support with correct commit-based path handling
4. **Path Validation**: Good security - rejects `../escape` and empty member names
5. **Dirty Worktree Protection**: Correctly blocks updates when changes exist
6. **--force Flag**: Proper override mechanism
7. **--only/--skip Filtering**: Works well including with `--frozen`
8. **VSCode Generator**: Produces correct workspace file
9. **JSON Output**: Consistent `--json` support across commands
10. **Status Command**: Informative with good warnings and hints

### Test Coverage
- 248/249 tests passing (99.6%)
- Good coverage of edge cases in unit tests
- Integration tests cover real git operations

### Documentation
- Comprehensive spec document
- Clear command reference
- Good workflow examples

---

## Recommendations

### High Priority
1. Fix race condition when syncing multiple refs of same repo
2. Improve tag detection (query remote or add explicit syntax)
3. Improve error messages for non-existent refs
4. Update spec to match implementation (or implement missing features)

### Medium Priority
1. Fix pin command to use commit-based paths per spec
2. Make store gc safer (scan multiple megarepos or require confirmation)
3. Fix CLI argument order sensitivity

### Low Priority
1. Make integration tests more environment-agnostic
2. Add `--verbose` flag as documented
3. Implement `mr store add` or remove from spec
4. Implement `mr exec --mode` or remove from spec

---

## Test Scenarios Executed

| Scenario | Result |
|----------|--------|
| Basic init | Pass |
| Add with GitHub shorthand | Pass |
| Add with HTTPS URL | Pass |
| Add with tag reference | Pass (but misclassified) |
| Add with branch reference | Pass |
| Add with local path | Pass |
| Sync default mode | Pass |
| Sync --pull mode | Pass |
| Sync --frozen mode | Pass |
| Sync multiple refs of same repo | Partial (race condition) |
| Pin/Unpin | Pass (but doesn't use commit paths) |
| --only filtering | Pass |
| --skip filtering | Pass |
| --frozen with --skip | Pass |
| Store ls | Pass |
| Store gc --dry-run | Pass (but only checks current megarepo) |
| VSCode generator | Pass |
| Nix generator | Fail (missing rsync - expected) |
| Dirty worktree protection | Pass |
| --force override | Pass |
| Path traversal prevention | Pass |
| Empty member name | Pass |
| Exec command | Pass |
| Status command | Pass |
| JSON output | Pass |

---

## Conclusion

Megarepo is a solid tool with a well-thought-out architecture. The store-based approach with per-ref worktrees is elegant and the frozen mode provides excellent CI reproducibility. The identified bugs are fixable and the design issues have clear paths to resolution.

The tool is usable for development workflows today with awareness of the limitations. For production CI use, the frozen mode works reliably. The main area needing attention is the tag/branch classification heuristic, which can lead to unexpected behavior with non-semver tags.

**Recommendation:** Address high-priority bugs before wider adoption, particularly the race condition and tag misclassification issues.
