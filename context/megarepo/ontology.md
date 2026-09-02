# Megarepo Ontology

The domain language of the megarepo tool (`mr`). This absorbs and supersedes
`packages/@overeng/megarepo/docs/glossary.md`, which covered store GC only.

Terms specific to the buck2-facing composition contract — cell, composition
root, isolation dir, action identity — are defined in
[../buck2/ontology.md](../buck2/ontology.md) and
[../buck2/05-composition/](../buck2/05-composition/requirements.md), and are
used here without redefinition.

## Language

### Repo arrangement

**Megarepo**:
A git repository containing a `megarepo.kdl` (or legacy `megarepo.json`). It
declares which repos are members and is the root of the composed environment.
Megarepos nest: a megarepo can itself be a member of another.

**Member**:
A repository declared in `megarepo.kdl`. A member is self-contained, works
standalone, and is not aware it is part of a megarepo.
_Avoid_: dependency, submodule (both imply a coupling that does not exist).

**Store**:
The host-global repository cache at `$MEGAREPO_STORE` (default `~/.megarepo`),
holding one bare repo per remote and one worktree per ref. Shared by every
megarepo on the machine — which is why every deletion rule in it is
cross-workspace.

**Canonical worktree**:
The store worktree at the path a ref implies (`refs/{type}/{raw-ref-path}/`).
Its path is its identity claim; a worktree whose checked-out `HEAD` disagrees
with its path is in **ref mismatch**, a state of conflicting evidence rather
than a known-wrong state.

**Pinned materialization**:
A `refs/commits/<sha>/` worktree, placed to satisfy an exact lock entry.
Nothing legitimately moves it, so drift from the lock is a failure of the
`mr apply` contract rather than a condition to skip past.

**Intent** / **resolved state**:
The two halves of configuration. `megarepo.kdl` is intent (hand-written, what
you want); `megarepo.lock` is resolved state (tool-written, what was actually
resolved). They are never merged and never derived from each other in the
`lock → kdl` direction.

**Pinned**:
A lock-entry flag meaning `mr fetch --apply` must not advance this member.
Orthogonal to ref type: ref type says what a member tracks, `pinned` says
whether the tool may move it.

### Workspace ownership

**Composition workspace**:
The synthesized root at which a composed build runs, located at the store
worktree path of the repo under development. It is not itself a git repository;
it holds the Buck root authority, `buck-out`, and the member mounts.
_Avoid_: composition root (that names the Buck-side artifact this workspace
carries, defined in the buck2 tree), checkout.

**Owned member**:
The workspace's single writable member — the branch-attached git worktree of
the repo the workspace exists to develop, and the default working directory for
work in that workspace. Exclusivity is git's one-worktree-per-branch rule, not
tool bookkeeping.
_Avoid_: root repo, primary member.

**Mount**:
A member's materialization inside a workspace at `repos/<name>`. Every member
that is not the owned member is a read-only mount of its locked revision:
tracked sources plus the dist overlay, protected files `0444` / dirs `0555`.
_Avoid_: link, symlink (the symlink shape is retired legacy, not the concept).

**Advance**:
Replacing a mount's content with a newer locked revision by staging a fresh
copy and exchanging it atomically, never by mutating the live mount in place.
The distinction matters because a live Buck daemon may be reading the mount
during the exchange.

**R6 identity**:
The content-identity layer for member mounts: canonical tree scan,
protected-tree verification, and the persisted mount manifest. R6 defines what
a mount _is_, in content terms, independently of the mechanism that produced
it; the **R6 post-condition** is the check that a freshly produced mount
matches the identity computed from its source.
_Avoid_: confusing this with `COMP-R06` in
[../buck2/05-composition/requirements.md](../buck2/05-composition/requirements.md)
("no member `.buckroot`"). Same spelling, unrelated concepts: `COMP-R06` is a
numbered composition requirement, R6 here is the name of a layer in `mr`. Where
both could be meant, write "R6 identity" or "COMP-R06" in full.

**Capability projection**:
The per-`(toolset, platform)` set of store-resolved executables copied into a
mount at `.buck2/capabilities`, verified by its own `--check` gate. Host state,
not repository content: it is gitignored, so a mount without it fails at load
rather than building against the wrong tools.

**Dist overlay**:
A member's Buck2-built dist artifacts at the locked revision, placed into the
mount alongside tracked sources so the `exports` types→dist mechanism resolves
across members. Digest-neutral by construction, since the root's
`[project] ignore` covers `dist`. Declared per member by a genie projection —
a manifest, never a glob.

**Update lock**:
The single workspace-scoped lock held across the capability, mount, and overlay
stages of `mr apply`, released only after root Buck authority is published. It
is what makes a workspace either fully at the lock or visibly refused, never
half-applied.

**Reference-only member** (`ignoredMembers`):
A configured legacy-symlink member that is a checkout, not a build input. Its
whole path enters the root `[project].ignore`, and no target or load may
reference it.

### Store liveness and reclamation

Carried forward from the GC glossary; decisions
[0001](./.decisions/0001-reclaim-cold-worktrees-in-default-gc.md),
[0006](./.decisions/0006-test-contract-and-validation.md),
[0007](./.decisions/0007-bounded-memory-and-throughput.md), and
[0008](./.decisions/0008-ref-mismatch-clean-archive.md) use these terms by
name.

**Cold worktree**:
A store worktree that no workspace is currently using AND that has been
continuously absent from every workspace live set for the grace window. Cold is
the precondition for reclamation. Opposite: **hot**.
_Avoid_: stale (reserved for the merge/age signal), unused.

**Live set**:
The union of store worktree paths recorded as in-use by all registered
workspaces, read from the liveness registry. A path in the live set is never
deleted.
_Avoid_: in-use set, active set.

**Liveness registry**:
The store-local cache at `$STORE/.state/workspaces/<hash>.json`, one record per
workspace listing its `livePaths`. A cache, not an authoritative index: a
workspace contributes only after running an `mr` command that refreshes its
record.

**Cross-megarepo veto**:
The rule that membership of a worktree in ANY workspace's live set forbids its
deletion, even when it independently looks reclaimable.

**Lossless floor**:
The precondition that deleting a worktree loses nothing irreplaceable: every
local commit reachable on a remote, no unpushed commits, no stash, and any
uncommitted state captured first. Distinct from staleness — the floor is about
safety, staleness about timing.

**Staleness**:
Positive evidence that a worktree's work is done: the branch's GitHub PR is
merged or closed. An open PR or no PR is not staleness, it means keep. Not
derivable from git ancestry, because the repos squash-merge.

**Grace window**:
The minimum duration a worktree must be continuously absent from all live sets
before it becomes cold — a buffer against deleting a worktree whose consumer
simply has not re-registered recently.

**Archive** / **reap**:
The two phases of reclamation. **Archive** moves a qualifying worktree to
`<repo>/.archive/<name>/` (recoverable, frees the branch ref so `mr apply` can
re-materialize); **reap** hard-deletes it once the archive ages past its
retention TTL, and is the step that actually reclaims disk.
_Avoid_: trash, recycle bin.

## Structure

The leitwort is **evidence**. Every destructive rule in this vocabulary is
phrased as a demand for positive evidence, and absence of evidence resolves to
_keep_ or _refuse_ — never to _proceed_. Cold, staleness, and the lossless
floor are three independent evidence sources for one deletion; the R6
post-condition is evidence a mount is what it claims; admission of a locked
source is evidence a materialization is canonical. The vocabulary splits along
the same seam as the tool:

```text
arrangement            ownership
  megarepo               composition workspace
  member          ──▶      owned member (writable, exactly one)
                  ──▶      mount (read-only, the rest)
  store                    ├─ R6 identity
  canonical worktree       ├─ capability projection
  pinned materialization   └─ dist overlay
  intent / resolved state  update lock
  live set, cold, archive, reap
```

A member is the arrangement-side noun; inside a workspace that same repository
is either the owned member or a mount. The two never coincide: one repository
has one role per workspace.

## Flagged Ambiguities

- **stale vs cold**: informal usage conflated "old/merged" with "safe to
  delete". Resolved: **staleness** is the merged/closed signal only; **cold**
  is the full deletion-eligibility state (not-live + grace window + lossless +
  stale).
- **`--all` mode** is not "delete everything stale" — it is the
  protection-bypassing mode that ignores the live set entirely. Cold
  reclamation is a separate, live-set-honoring path within default gc.
- **R6 vs COMP-R06**: see the R6 identity entry above. Unrelated concepts that
  collide in shorthand.
