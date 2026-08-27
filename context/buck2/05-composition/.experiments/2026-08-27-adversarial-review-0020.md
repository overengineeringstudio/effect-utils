# Adversarial Review of Proposed Decision 0020

Date: 2026-08-27 — Host: dev3 — Subject: proposed decision 0020
(content-real read-only member mounts now, writable deferred) and the
19-point agent workflow contract.

## Question

Does proposed decision 0020 survive adversarial attack against the goals —
best, most principled, yet simplest design maximizing shared-cache reuse,
low global complexity, and sound agent workflows — or does it hide broken
premises?

## Method

Independent adversarial critique (kind: critique/review, not a build
experiment): six attack vectors driven against the proposal using
source-read evidence from mr (`packages/@overeng/megarepo`), the live devenv
configurations of consuming repos, a filesystem census of the megarepo
store, measured git-worktree bookkeeping behavior, and time-boxed
comparative research on prior art (git submodules, EdenFS/Sapling, josh,
jj). Verdict per attack: BROKEN with evidence, or HOLDS.

## Result

- **Attack 1 — hidden in-mount write consumers: BROKEN.** Composed
  workspaces run destructive writes inside member mounts today as
  configured policy: a private downstream repository's `devenv.nix` declares four pnpm task modules
  with `workspaceRoot = "repos/<member>"` (effect-utils, livestore, and two private members), and its `nestedRepoPreInstall` (~line 58)
  begins `find . -type d -name dist … -exec rm -rf {} +` inside three
  member trees it does not own; dotfiles `devenv.nix:2639` executes member
  source via bun out of `repos/effect-utils`, resolving bare specifiers
  through the mount's `node_modules` (present only because the mount is a
  symlink to a fully-installed worktree). These live in OTHER repos'
  configs; nothing on the roadmap retires them. Related named hole:
  cross-member TypeScript consumption is specified nowhere — `dist` is
  gitignored (absent from any content-real materialization by
  construction) and the editor surface writes inside the member tree, so a
  consuming developer has no specified route to types under read-only
  mounts.
- **Attack 2 — the deferred-writable simplicity claim: BROKEN.**
  effect-utils holds TWO cell identities: root cell of its own builds
  (where the Phase-1 cache claim lives) and member cell in 255 mounts on
  this host — two digest namespaces, violating COMP-R02 for the hub and
  forfeiting BUCK-R06/criterion 6 exactly where development happens
  (effect-utils-as-root-cell was never measured in the identity
  experiments). Resolving the duality the principled way makes Phase 2
  itself manufacture the deferred demand: the roadmap deletes the member
  `.buckconfig` (removing the build-from-own-root shape), and with mounts
  as read-only views of LOCKED revs a developer has no way to buck2-build
  uncommitted work — the inner loop would become edit -> commit -> push ->
  repin -> apply. The deferral schedules the mount-regime fork for the
  moment Phase 2 lands; committing to never-writable is unavailable for
  the same reason.
- **Attack 3 — mechanism scale: HOLDS**, with one defect: 0020's
  "write-protected hardlink farm" alternative is unsound (chmod mutates
  shared inodes — it write-protects the source; directory-only chmod does
  not stop in-place truncate writers) and should be struck. Measured
  scale: effect-utils `.bare` holds 162 worktree registrations,
  `git worktree list` costs 83 ms; growth is linear and cheap. Store
  filesystem facts: all 282 composing workspaces sit on ext4 (1.8 T, 96%
  used, ~70 GB free, no reflink); ZFS `bulk` has 19.3 T free with CoW
  verified. Census: 1193 `repos/*` entries — 1175 symlinks (255 dangling,
  21%), 18 already-real directories. Everything-converted tracked-content
  ceiling ≈ 27 GiB (effect 37 MiB x 310 + livestore 65 MiB x 133 +
  effect-utils ~29 MiB x 255 + remainder), most of it in archives that
  need no conversion; the 330 GB "usable dev checkout" tier is infeasible
  against 70 GB free — independent corroboration that mounts must never
  carry `node_modules`.
- **Attack 4 — migration realism: HOLDS with a required guard.**
  Conversion is per member cell, non-destructive to store worktrees, no
  flag day. Required first: mount-design S0 (the current
  `status: 'skipped'` exit-0 bail at `member.ts` for non-symlink mounts
  becomes loud and non-zero) plus a refuse-to-delete guard for
  non-mr-managed real directories — 18 such directories already exist in
  the wild.
- **Attack 5 — comparative sanity: HOLDS; no simpler prior art.**
  `git submodule` rejected for three concrete reasons: an independent
  object store per submodule forfeits the shared-`.bare` object sharing mr
  exists to manage (`--reference`/alternates is fragile under gc); the
  gitlink duplicates megarepo.lock's job inside the superproject's git
  history (every repin becomes a commit); fixed superproject-relative
  paths fight COMP-R02 under nested megarepos. Systems delivering
  content-real AND writable-shared simultaneously (EdenFS/Sapling virtual
  checkouts, bind mounts) all require a daemon or privilege — rejected
  class on macOS/unprivileged grounds. Nobody achieves it with plain
  files; read-only is the honest response to the design space.
- **Attack 6 — the contract: BROKEN as a simultaneous adoption.** Points
  4, 16, 18 are written for the symlink world (mount-and-store same inode;
  pin-then-author yields a writable mount surface; apply-repoints hazard)
  and become false or moot under content-real mounts — a rev 3 must
  redefine the store worktree as the sole authoring surface and
  `repos/<member>` as a read-only build input. The `CI=true` silent-detach
  trap (`engine.ts:635-638` resolves `auto` to commit mode with no
  diagnostic) needs an mr CODE change (loud diagnostic or refusal outside
  real CI), not a contract line — prose competing with a silent default
  loses.
- **Strongest simplification found:** one-writable-mount workspaces —
  every repo, including the one under development, lives at
  `repos/<name>` in a synthesized composition root; the owned repo is THE
  single writable branch-attached worktree (on the branchy-created branch
  the agent owns, so exclusivity is free by construction); all other
  members are read-only locked mounts. This resolves the identity duality
  (one cell identity per repo everywhere), dissolves the deferral
  contradiction, and removes the `<root-repo> = .` special case from the
  generator. Cost: relocates the workspace model one level down (fleet
  git-wrapper store-root rule, one-time migration). It does NOT solve
  Attack 1 (the private downstream repo writes into members it does not own either way).
  Paired suggestion: ZFS-resident disposable composition roots retire the
  disk axis. Status: q13 (2026-08-27) chose pause-and-prototype before
  committing.

## Conclusion

REVISE — do not accept 0020 as written. The mechanism direction
(content-real, detached, read-only) survives every attack and has no
simpler prior art; the deferral framing and the unowned in-mount write
consumers do not survive. Revision list: own or retire the legacy write
consumers with a named phase; specify cross-member TS consumption or record
it as an owned open question; resolve the hub identity duality before the
generator lands (the one-writable-mount workspace shape is the leading
candidate, pending its prototype); strike the hardlink alternative; rewrite
the deferral honestly; contract rev 3 plus the engine.ts code change; land
S0 and the foreign-real-dir guard before any conversion; record the
git-submodule rejection; add the measured disk figures.

## VRS Impact

Holds proposed decision 0020 at proposed status pending the
one-writable-mount workspace prototype (q13); enumerates its revision
list. Feeds COMP-R02 (hub identity duality is a live violation),
COMP-R10's migration guards (S0 + foreign-real-dir refusal), the workflow
contract rev 3, and two newly named open questions with owners required:
cross-member TypeScript consumption, and retirement of in-mount write
consumers in private-downstream and dotfiles devenv configurations.
