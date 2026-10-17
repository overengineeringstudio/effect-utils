# Materialization Spec

This document specifies the materialization action and the editor surface. It
builds on [requirements.md](./requirements.md). Mechanisms are
prototype-validated; see [.experiments/](.experiments).

## Status

Draft.

## Scope

**Defines:** the per-package materialization action, normalization, the editor
view, and the staleness gate.

**Does not define:** semantic dependency declaration (01), tool provisioning
(02), or cache transport (04).

## Materialization Action

```text
translate (genie, freshness-gated)
  pnpm-lock.yaml (+ pnpm-workspace.yaml, patches)
  -> per package version: fetch target (url, sha256 from generated sidecar)
                          extract target (tarball -> package tree artifact)
  -> per importer:        node_modules assembly target
  -> platform constraints on optional/platform packages (select())

fetch     download_file, remote-cacheable, network only here (BUILD.BUCK.MAT-R08)
extract   tar -> package tree, local-materialization-policy (no AC reads/uploads)
assemble  importer virtual store: .pnpm/<name>@<ver>[_peer-suffix]/node_modules/<name>
          hardlinks from extract artifacts, relative symlinks for edges,
          workspace: edges as relative links, .bin entries as symlinks
          local-materialization-policy (BUILD.BUCK.MAT-T01); public node_modules output
```

Extract, store-entry, store-SCC, store-view, and package-tree rules use the
default non-remote execution platform, not the cache-admitted platform.
Their cheap filesystem projections are recomputed locally; declared outputs,
incremental invalidation, and editor backing-root completeness are unchanged.
The decision and measured transfer cost are specified by
[the local materialization policy](../06-reuse-client/spec.md#local-materialization-policy-buildbuckreuse-r08r10).

No package manager executes inside Buck actions. pnpm is the developer-time
resolver that writes `pnpm-lock.yaml`; the generated sha256 sidecar is derived
from the lockfile's sha512 integrity values and verified against them at
generation, so it cannot disagree with the lockfile except by staleness, which
the freshness gate rejects. The lockfile's peer-suffixed snapshot keys map
directly to virtual-store entries; peer resolution is not re-derived.

Invalidation is structural (BUILD.BUCK.MAT-R07): a changed package version re-runs its
fetch and extract and the assemblies of importers whose closure contains it;
unrelated importers are untouched. A change that leaves an importer's closure
byte-identical re-runs nothing for it.

Lifecycle scripts are not executed (ratified policy: builds disallowed;
`requiresBuild` is empty in the lockfile). A package that would require a
build fails admission until a declared mechanism exists. `patchedDependencies`
apply during extraction as declared inputs. Optional platform packages are
filtered by cpu/os constraints so foreign-platform entries are neither fetched
nor linked.

The assembled tree is relocatable (no absolute paths) but hardlinks share inodes
with extract artifacts; Buck resets output modes, so read-only protection is
applied on the published editor view, not inside `buck-out`. The retired
deploy-based two-stage action and its normalizer are recorded in
[the retained experiment](.experiments/2026-08-26-two-stage-prune-install.md)
and superseded by
[the closure prototype](.experiments/2026-08-30-declared-closure-prototype.md).

The package-tree API projects declared workspace files into the output for
cacheable consumers; the editor-surface realization provides BUILD.BUCK.MAT-R03
live-source links outside the cacheable package tree without weakening
BUILD.BUCK.MAT-R02.

## Editor Surface

The repository-root source-generator consumer and each admitted workspace
package `<package>` expose `:<editor_inputs>` as their canonical Buck dependency
view and `:editor_view_inputs` as the manifest joining that view, the package
tree, and every provider-declared backing root. The stable filesystem shapes are:

```text
<package>/node_modules
  -> ../../.editor-view/<view>/node_modules
<package>/../../.editor-view/<view>
  -> .store/<view>-<snapshot-identity>
<package>/../../.editor-view/.store/<view>-<snapshot-identity>/
  editor-view.json
  node_modules/
  .backing/
```

```text
node_modules
  -> .editor-view/root/node_modules
.editor-view/root
  -> .store/root-<snapshot-identity>
```

Package consumers share a two-level state root; the root source-generator
consumer uses the repository-local `.editor-view/root` state. Every published
link remains inside the repository while context packages,
`packages/@overeng/*`, nested workspace packages, and root generators use the
same publisher.

Each schema-v2 record binds the package, Buck cell and target, selected
`editor_inputs` fingerprint, normalized declared-root digest, exact selected
view digest, exact byte-owned snapshot digest, and deterministic snapshot name.
Tree digests use the `effect-utils/tree-digest/v1` domain separator, unsigned
UTF-8 byte ordering, length framing, and fail-closed checks for special or
concurrently changing files.

Before publication, `buck2:editor:authority` compares the canonical admission
registry with tracked package manifests and a Buck `owner(...)` census. The
resulting authority file must name identical required and owned package sets;
every package publication validates it.

Publication holds the exclusive state-root `.publish.lock`, created atomically.
An existing lock fails immediately and prints the explicit token-gated recovery
operation. There is no age heuristic, timeout, or automatic lock theft. Under
the lock, the publisher:

1. fingerprints each distinct selected dependency view and finite declared root
   once for the admitted state;
2. derives the content-addressed snapshot name before copying; if that entry
   exists, verifies its complete immutable payload and exact admission record
   and reuses it without writing store bytes;
3. for a missing entry, copies the selected view and disjoint backing roots into
   a same-filesystem byte-owned candidate, relocates links into `.backing/`,
   rejects links outside declared roots, and proves no snapshot file shares an
   inode with a disposable source;
4. verifies the complete payload digest and writes `editor-view.json`;
5. hardens the new candidate read-only and renames it to the deterministic
   snapshot;
6. atomically renames the current pointer, installs or validates the package
   first hop, and emits the package-manifest settle signal required by live
   language servers;
7. updates the retention record and garbage-collects snapshots outside the
   configured finite retention set. Retention proves every snapshot of the
   published view read-only in full; a store entry owned by another view is
   proven only by its self-addressed record and read-only root, because its
   owner proves its payload in full at every publication, reuse, and check. A
   whole-workspace publication therefore stays linear in total snapshot size.
   Pointer helpers validate their exact writes; a separate
   `buck2:editor:check` performs the full admitted-state traversal.

If a legacy root install occupies the first hop, immutable GNU
`mv --exchange --no-copy` installs the symlink without an absent-path window and
retains the exchanged entry under `.legacy/`. A failure before the pointer flip
leaves the prior current view intact. Snapshot payloads never retain links into
`buck-out`, whose action directories Buck may delete before rebuilding.

Repository tasks configure two completed snapshots **per view**: current and
previous. For `N` admitted views the shared-store bound is `2 × N`, excluding
in-flight candidates, which are not retention garbage. GC deletes only
validated older snapshots of the publishing view after its pointer flip; it
neither infers process liveness nor collects inactive worktrees. The preceding
snapshot supplies a bounded rollback/read-overlap window, not an indefinite
lease for a process pinned to an older generation. Literal admitted link text
participates in identity, so changed Buck artifact paths can create a new
snapshot even when dependency file bytes remain identical.

## Staleness Gate

`buck2:editor:bootstrap` regenerates whole-workspace ownership authority but
builds and publishes only the declared source-generator import closure: the
repository-root dependency view backed by Genie's package tree and the
OpenTelemetry contract view needed by Genie's Weaver runtime. The shared Genie
runtime-closure walker checks every generator before `genie:check` and names any
first-party package imported outside that declaration, so a new edge cannot
silently rely on a stale whole-workspace publication. Bootstrap therefore stays
bounded by source-generator dependencies instead of every workspace package. It
exists only to make `genie:check` runnable and reports no governed evidence.
After freshness and workspace reconciliation, `buck2:editor:publish` and
`buck2:editor:check` derive the complete root-plus-package set from the canonical
source registry, regenerate whole-workspace ownership authority, build every
`:editor_view_inputs` manifest in one Buck invocation, then publish or validate
each consumer in deterministic order. The checker validates record schema and
identity, both symlink hops, state-root containment, pointer liveness, snapshot
completeness, immutable payloads, retention state, and admitted versus recorded
digests. It does not use tsgo as an oracle.

The mutating `buck2:editor:materialize` entrypoint serializes `mr:setup`,
bootstrap publication, `genie:run`, `genie:check`, `mr:apply`, and authoritative
editor publication. TypeScript declaration publication waits for that barrier.
This does not change the standalone freshness contract: `genie:check` still
runs after bootstrap without invoking `genie:run`, so it cannot repair the
projection it proves.

`buck2:editor:publish:test` publishes only the views the source-side test
partition executes through: every source test package, the repository root,
and the packages `devenv-modules:test` runs from source. Test lanes, the
`check:all` aggregate, and its observability profile depend on it instead of the
whole-workspace publisher, so a test run does not rebuild views no test reads.
Views outside that set refresh only through `buck2:editor:publish` or
`buck2:editor:materialize`, which setup runs. Two publishers sharing the
`packages/.editor-view` state root must never be scheduled without an ordering
edge: the publication lock fails fast instead of waiting, so
`scripts/devenv-task-graph-check.mjs` rejects such a task graph.

Missing, malformed, escaping, dangling, incomplete, or stale state fails with
the recorded and current identities. `buck2:editor:recover-lock` is the only
recovery surface; it requires both `EDITOR_VIEW_PACKAGE` and the exact printed
`EDITOR_VIEW_LOCK_TOKEN`, and neither builds nor mutates snapshots.

## Relationship to Exact Closure Materialization

The declared closure above is the per-package fetch-and-verify tier that the
retired package-evidence regime anticipated. It is introduced with live
consumers (the admitted packages) under the Buck admission contract; no
evidence infrastructure from the retired regime is revived.

## Shared Byte-Owned Root Store — Draft

**Status: Draft; design review only, not the current publisher realization.**
This section refines BUILD.BUCK.MAT-R04/R05/R06/R07. It shares retained,
byte-owned artifacts within one worktree; it does not link to disposable Buck
outputs, introduce a cross-worktree cache, or infer editor-process liveness.

### Layout and identity

```text
<repo>/.editor-view/
  .roots-v1/<component-key>/
    root.json
    members/<member-id>/             # owned files and relocated graph links
  .root-publish.lock                # serializes all worktree view roots and GC
<editor-root>/.store-v3/<view>-<view-key>/
  editor-view.json                  # admission, members, complete component set
  node_modules -> <relative shared member path>
<editor-root>/<view> -> .store-v3/<view>-<view-key>
```

One shared store serves both the repository-root and package editor roots.
The provider supplies each declared root's portable identity as the canonical
object `{cell, target, output}`; absolute output paths and per-view `.backing`
ordinals are not identities. `member-id` is its framed SHA-256. A root's file
inventory hashes relative paths, entry kinds, and regular-file bytes. Each
link hashes its lexical destination as `(member-id, path-within-member)`,
preserving intermediate link hops rather than collapsing them with `realpath`.
Containment and resolution proofs still reject links outside admitted roots.

Declared roots form a directed link graph. Strongly connected components are
stored together so cyclic package dependencies do not require circular Merkle
hashes. Compute component keys bottom-up on the acyclic component graph:
frame byte-sorted member identities and inventories, internal edges by member
identity, and external edges by destination component key and member identity.
This makes equal dependency graphs share storage across views and Buck path
changes. A changed dependency can re-key its ancestors; unaffected components
remain reusable. No hash relies on a partially populated destination.

The repository owns the `effect-utils/editor-view-shared-root/v1` record
namespace and a new `effect-utils/editor-view/v3` view record. Keys are
lowercase 64-hex SHA-256, member identities are case-sensitive, and records use
exact field sets, byte-sorted lists, explicit schemas, and framed hashing.
Unknown schemas, duplicate members, mismatched self-addresses, escaping
paths, or unknown edge targets fail closed. Root records bind member payload
digests and dependency keys; view records bind existing exact admission
fingerprints, the selected member, and the complete reachable component set.
The view key hashes that entire record identity, not just its selected root.

### Link relocation and publication

```text
admit + hash graph -> validate/reuse roots OR copy missing component
                  -> seal roots -> seal view manifest -> atomic current flip
                  -> retain current/previous -> mark -> sweep
```

Acquire the common worktree lock before any view-root lock, following one fixed
order. It retains the current exact-token, fail-fast recovery policy; there is
no concurrent publisher or GC in the shared namespace. Admission validates
whole-workspace authority and fingerprints every source before copying.

For each missing component, copy its members into a same-filesystem candidate
with independent source inodes. Relocate internal links between candidate
members and external links to already sealed dependency components. The
component DAG orders creation; internal cycles use relative member paths.
Compare copied bytes and the pre-relocation literal-link inventory to admission
to reject concurrent source changes, including a same-resolution retarget.
Harden and verify the complete component before installation. An existing key
is fully verified against its immutable record and admitted graph before reuse,
never repaired in place or overwritten. The allowed payload link boundary
changes from one snapshot to the explicitly recorded shared component closure,
not to arbitrary worktree paths.

View candidates contain only immutable admission/closure metadata and a
relative `node_modules` link into the shared store. All roots are installed and
validated before sealing the view and atomically renaming its current pointer.
First-hop adoption and language-server settle signalling keep their existing
contracts. A pre-flip failure leaves the previous view usable. A post-flip GC
failure leaves a complete usable current view and conservative extra storage.

Directory links are deliberate: a module's real path lands in a complete,
relocated shared member whose own dependency links remain resolvable. Merely
symlinking individual files from a per-view tree into an edge-free CAS payload
would break Node's realpath-based package resolution. Hardlinks to Buck outputs
remain forbidden; no shared component depends on `buck-out` or `/nix/store`.

### Reachability, bounded retention, and crash safety

Use **mark-and-sweep, not persisted refcounts**. Under the common lock, mark
the component closure of every current and previous v3 snapshot across both
editor-root namespaces, plus durable in-progress transaction manifests.
Enumerate installed snapshots rather than trusting only the latest source
registry: a removed consumer cannot silently lose its published roots.
Removing a consumer is an explicit authority-backed operation that removes its
pointer/retention record before releasing its roots. Unknown or malformed
ownership, pointers, manifests, or root records abort sweeping.

First prune older completed view snapshots using the existing ownership checks.
Then mark all remaining owned snapshot manifests, including conservatively
retained crash debris. Only unmarked, validated shared entries may be renamed
to same-filesystem transaction trash and deleted. The live current pointer and
previous snapshot are never swept. The bound is two completed snapshots per
view plus their union of reachable components; candidates/failed transactions
are separately recoverable, not silently aged out.

Root files and records are flushed before their candidate rename; directory
entries are flushed before installing the view and before flipping the pointer.
A durable transaction record lists its owner token, pre-flip pointer, proposed
view, newly installed roots, and GC trash. Pointer-flip crash ambiguity is
resolved by comparing the actual pointer with that record, not by timestamps.
Exact-token recovery validates either the old or new complete view, discards
only proven abandoned candidates, rebuilds the mark set, and resumes eligible
trash deletion. It cannot steal an active lock or delete ambiguous state.
Orphan sealed roots are harmless until a subsequent locked sweep proves them
unreferenced. No reference can be created during sweep or trash deletion.

Current plus previous preserves the existing read-overlap window, not an
indefinite lease for an unmanaged editor pinned to an older generation.
Managed consumers needing longer retention require explicit durable leases
whose component closure is also marked; such a lease protocol is outside this
draft and is not approximated with PID scans, refcount guesses, or timeouts.

### Migration and acceptance

The snapshot state is a rebuildable local projection, but its currently selected
generation remains reader-visible. Stop old publisher/watch daemons and upgrade
every task/daemon caller before activating v3; old readers may coexist, old
writers may not. The current v2 publisher does not implement the common lock or
a v3 layout fence, so a schema change alone is not writer fencing. Migration
requires an explicit single-writer maintenance boundary, with an interrupted
cutover remaining at the last validated pointer.

Introduce v3 and the shared namespace alongside read-only v2 stores. Under the
common lock, validate each admitted view, publish its complete v3 replacement,
and atomically flip that view without deleting its v2 previous generation.
Migration can consume fresh Buck artifacts or fully validated v2 owned payloads;
it cannot trust old directory names alone. Existing v2 snapshots keep owning
their bytes and need no shared-root marks. Keep one previous generation across
both schemas, then prune v2 through ordinary per-view retention as it ages out.
Once no pointers/retention records name v2, remove its empty store and retire
the v2 reader. A mixed store never requires an all-at-once destructive reset.
The new publisher rejects unknown active-layout versions; rollback to an old
publisher requires returning every pointer to a complete v2 generation first.

Acceptance proofs: equal roots across sibling views occupy one component;
unchanged republish copies zero payload bytes; changed roots cannot alias old
keys; cyclic closures and Node runtime/editor resolution survive relocation;
root tampering and source mutation fail closed; current/previous readers
survive a flip and GC; deleting all Buck artifacts leaves views usable; crash
injection at every install/flip/trash boundary preserves a validated view and
recovery converges; mixed v2/v3 migration retains the correct previous view.

**DQ1 Component economics:** Measure SCC sizes, ancestor re-keying, and overlay
metadata on the real workspace graph. The sampled current-view duplication
suggests an upper-bound saving of approximately 4.97 GB per worktree, but only
an implemented graph-layout measurement can establish the realized saving.

**DQ2 Resolver and live-source boundary:** Prove the shared member's realpath
semantics with the Node/Bun runtimes, editor language servers, and the existing
live-workspace sibling realization (BUILD.BUCK.MAT-R03) before admission.
Sharing dependency bytes must not turn live-source links into frozen sources.

