# One-Writable-Mount Workspace Prototype

Date: 2026-08-27 — Host: dev3 — Buck2 pin 2026-04-14-7600cb80; private
bazel-remote on 127.0.0.1:41145 (shared fleet instance untouched).

## Question

Does the one-writable-mount workspace shape — every repo at `repos/<name>`
inside a synthesized workspace root, the owned repo as the single writable
branch-attached worktree, every other member as a read-only `cp -a` mount at
its locked revision — deliver one cache namespace across dev and consumer
workspaces, a sound dev loop, and an acceptable daily-loop DX (the q13
pause-and-prototype condition for decision 0020)?

## Method

Built the full shape in scratch from read-only fixture clones: a synthesized
workspace root (validated `.buckconfig` shape, toolchains cell, capability
projection copied in, `.buckroot`, fixed isolation dir) containing a writable
branch-attached worktree (`dev-proto` from a scratch bare) and a read-only
`cp -a` member mount, plus a separate consumer workspace with the same cell
names and mount paths. File-set parity between mount shapes was checked
BEFORE building. Digests were read from the event log per build; the
criterion-6 round trip ran against a fresh empty private cache with a
deliberately digest-moving commit after a first attempt with a
non-digest-moving commit was discarded as non-discriminating. The daily loop
was timed as an agent would live it; fleet git-policy sources were read
(read-only) to inventory layout-sensitive rules.

## Result

- **Namespace unity PASS:** writable dev worktree and read-only consumer
  mount at the same commit both produced digest
  `651a7be53175d1bd…3462:142`; a third workspace at another absolute path
  built at 100% remote cache. Pre-build parity: path sets identical (49=49),
  exec bits and content identical; only the write bit differed (644 worktree
  vs 444 store copy) and it is not in the digest — the pass is explained,
  not lucky. The isolation dir is the real namespace split: the same
  consumer workspace with the default isolation dir instead of
  `--isolation-dir megarepo` gave `b80771e0…ec3f:142` (COMP-R07 is
  load-bearing).
- **Dev loop PASS:** appending one line changed the digest to `d211951c…`
  in 908 ms; `git checkout -- <file>` restored `651a7be5…` byte-exact in
  625 ms; `git status --porcelain` sees the dirty file natively.
- **Criterion-6 PASS with a discriminating key transition:** consumer cold
  at C3 → AC GET `651a7be5` NOT FOUND → built locally. Dev committed a
  digest-moving change (C4, digest `263e7c6d8a98bb21…d17c4:142`), pushed,
  cold-built with AC PUT OK. Consumer advanced C3→C4 (stage + one
  `mv -T --exchange --no-copy`, 841 ms; mount byte-identical to store@C4),
  then cold-rebuilt: AC GET `263e7c6d` OK, executor `Cache`, 100% hits,
  0 local actions. The consumer's lookup key changed as a result of the
  advance alone and hit an entry only the dev workspace could have written.
- **Exclusivity by construction:** a second
  `git worktree add … dev-proto` fails with git's own "already used by
  worktree" error; no mr machinery needed.
- **Timings:** acquire 137 ms at fixture scale / ~380 ms at real tracked
  scale (root 10 ms + writable worktree with caps 59/168 ms + read-only
  mount 55/~200 ms); acquire-to-push 1,946 ms (first build 1,105 ms at 100%
  remote cache, warm edit rebuild 374 ms, add+commit 254 ms, push 63 ms);
  `genie --check` from the member cwd 7.0 s and generate 18.7 s (real
  scale); devenv shell cold eval 91 s.
- **COMP-R06 verified three ways:** identical digest with cwd at the
  workspace root, the member dir, and the package dir; no second `buck-out`
  appears inside the member even with the member's own `.buckconfig` still
  present — `.buckroot` determines the project root. Bare-checkout probe:
  with the member `.buckconfig` present and no `.buckroot` above, the member
  becomes its own project root, creates a stray `buck-out`, then fails at
  parse; with it deleted, buck2 refuses before doing anything ("Couldn't
  find a buck project root") — strictly better failure, validating the
  planned deletion.
- **Policy findings settle the layout:** the fleet git policy's
  `guard_worktree_placement` refuses `git worktree add` outside the megarepo
  store root, and the search policy refuses shallow paths under
  `~/.megarepo` — together forcing (and thereby endorsing) the layout where
  the existing store worktree path BECOMES the workspace root
  (`…/<owner>/<repo>/refs/heads/<branch>/` holding `.buckconfig`,
  `buck-out`, `repos/*`), which also keeps every store-hygiene, GC, and
  search rule working. A `~/.megarepo/.ws/<name>` layout fails the search
  policy outright.
- **Frictions (DX, not correctness):** nothing works ONLY from the workspace
  root (git, devenv, genie, pnpm all want the member cwd), so the default
  agent cwd should be `<ws>/repos/<owned-member>`; the workspace root is not
  a git repository; read-only mounts carry tooling for exactly one member
  (the cross-member TypeScript question is unchanged by this shape);
  comparing the real worktree against its tracked tier found 121 live-only
  entries exposing `[project] ignore` gaps (`**/dist`, `**/__pycache__`,
  `packages/.editor-view` — whose hashed dir names miss the plain
  `node_modules` ignore entry); `buck2 root` defaults to `--kind cell` and
  prints the member from a member cwd (`--kind project` for the workspace);
  teardown of protected mounts needs a dirs-only unprotect first, so it must
  be an mr command.
- **Anomaly flagged (shape-independent, undiagnosed):** one genrule looked
  up one key and uploaded under another IN THE SAME BUILD, reproduced inside
  a single workspace against its own upload; the cacheable real target
  shared keys correctly.

## Conclusion

The one-writable-mount workspace shape works end to end: one cell identity
and one cache namespace per repo across dev and consumer workspaces,
criterion-6 reuse proven with a discriminating experiment, exclusivity free
from git itself, and acquisition cheap enough (~380 ms) to make workspaces
disposable. The remaining costs are named DX items with owners, not
correctness risks. Not measured here: macOS (RENAME_EXCHANGE on APFS remains
the load-bearing unknown from the mount e2e), full-scale tierA builds
(fixture-scale digest claims are exact but small), and enforcement of the
single-writable-member intent (currently unenforced by the generator).

## VRS Impact

Satisfies the q13 pause-and-prototype condition; finalizes decision 0020 as
accepted (q14) in its one-writable-mount form. Feeds the COMP requirement
updates (workspace root at the store worktree path, hub at `repos/<name>`,
default member cwd), the per-member ignore audit, the `buck2 root` and
teardown items in the mr command surface, and roadmap Phase 2. The macOS
primitive verification, tierA build validation, and the genrule key anomaly
carry forward as Phase-2 obligations.

## Amendment 1 — Apparent Genrule Key Mismatch Retracted

A 2026-08-27 minimal reproduction disproved the claimed target-key split. For
every cacheable genrule/custom-run shape tested, the Buck event
`CacheQuery.action_digest` and `CacheUpload.action_digest` matched, and the
wiped-daemon repeat hit the prior upload (12/12 cacheable repeats; 0/14
mismatches across eight shapes).

The extra server-side AC PUT was Buck's RE write-permission probe. Its decoded
command was `/command -to check permission EMPTY_ACTION_RESULT_…`; it was not a
target action. The plain genrule queried AC but correctly emitted no target PUT
because Prelude set `allows_cache_upload=false`. Pairing that GET with the next
uncorrelated server-log PUT created the false mismatch. Target cache identity
claims must correlate Buck-owned CacheQuery/CacheUpload event records, not
adjacent server access lines.

Issue #1160 is therefore closed as a corrected observation, and the anomaly no
longer gates tier-A validation.
