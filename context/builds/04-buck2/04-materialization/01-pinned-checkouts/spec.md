# Shared Pinned Checkout Custody Spec

This document specifies readiness and exclusive mutation custody for shared,
commit-pinned effect-utils checkouts. It refines
[BUILD.BUCK.MAT-R05/R06](../requirements.md) and the
[parent materialization contract](../spec.md); it does not authorize a new
package-manager backend or change dependency authority.

## Status

**Draft, spec-first.** The custody coordinator, readiness record, and consumer
launcher below require implementation. Existing publication locks do **not**
implement this cross-consumer protocol. Until then, an explicitly designated
single custodian must arrange quiescence and readiness out of band; an arbitrary
consumer is not authorized to install. If no custodian or quiescence proof is
available, fail with a readiness request rather than mutate the checkout.

## Scope and existing mechanisms

| Mechanism                        | Implemented today                                                                                                                                              | Boundary                                                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit-addressed store checkout  | `mr` resolves pinned members to `refs/commits/<sha>` when a reusable branch checkout is unsuitable                                                             | Commit identity is not an install lock or readiness guarantee; this protocol requires the commit checkout, not `refs/heads/*`                                                  |
| Managed pnpm mutation            | `acquire_pnpm_materialization_root_lock` takes a per-materialization-root exclusive flock, then the PNPM_HOME lock and shared `acquire_pnpm_store_cache_lease` | Managed mutations of one root remain serialized even with different PNPM_HOME values; raw pnpm bypasses these guards, and consumer readiness/lifetime admission is not covered |
| Current dependency setup         | Root `devenv.nix` sets `materialize = false`; README documents `buck2:editor:materialize` and scoped publication                                               | pnpm is lockfile-authoring only; there is no current supported root `pnpm:install`                                                                                             |
| Atomic publication and retention | Editor snapshots, `.publish.lock`, generation reader leases/pins; `buck2:typescript:materialize-dist` publishes declarations atomically                        | Atomic pointer publication does not prove aggregate readiness or retain an external consumer's entire checkout                                                                 |
| Teardown                         | `worktree-teardown` and editor release refuse unsafe removal                                                                                                   | External custody leases must also be integrated before automatic retirement can honor this protocol                                                                            |

Implementation references: [pnpm tasks](../../../../../../nix/devenv-modules/tasks/shared/pnpm.nix),
[root task policy](../../../../../../devenv.nix),
[setup instructions](../../../../../../README.md#publish-dependency-views),
[store commands](../../../../../../packages/@overeng/megarepo/docs/commands.md),
and [generation leases / teardown](../spec.md#generation-reader-leases).

## Actors and exclusion (R05)

```text
consumer -- readiness request --> designated custodian
consumer -- shared custody lease --> ready checkout --> runtime
custodian -- exclusive custody lease --> setup --> verification --> ready record
```

The **custodian** is the one configured operator or service authorized to perform
checkout bootstrap, repair, dependency publication, declaration publication, or
retirement. A consumer may act as custodian only through an explicit assignment,
not because it found a missing directory. A **consumer** requests a commit and
exports, waits, verifies, and writes links only inside its own checkout.

Required coordination uses the existing native `flock` primitive, not a new
PID-file lock. One persistent control is keyed by canonical checkout root:
`<canonical-git-common-dir>/effect-utils-pinned-setup/<root-key>/custody.lock`,
where `root-key` is lowercase SHA-256 of the UTF-8 canonical absolute root path.
All aliases resolve to the same root before choosing the control. Controls live
outside replaceable payloads, are private regular files owned by the custodian's
user, and must be validated without following symlinks. Never unlink or replace
a control: a second inode would split exclusion. This is a same-user,
single-host, known-local Linux/macOS filesystem contract; network filesystems,
foreign ownership, ambiguous identity, and unsafe controls fail closed.

Only the custodian holds `LOCK_EX` for mutations. Consumers hold `LOCK_SH` from
final validation through all reads, including descendant processes and later
invocations opening persistent links. A symlink alone holds no lease. Descriptor
inheritance and close-only release reuse the native generation-lease launcher
pattern; no explicit unlock may release a descendant's protection. Every setup,
repair, cleanup, GC, and teardown entry point must honor this outer lock.
Acquire custody before existing materialization-root/publication/store/generation
locks, preserving their internal ordering; never request custody while holding
an inner lock. Managed pnpm backends retain the existing root → PNPM_HOME → store
lease order: `pnpm-storage.nix` supplies `<cacheRoot>/pnpm-install.lock` with a
600-second wait to `acquire_pnpm_materialization_root_lock`. Build on that root
mutation exclusion rather than replace it with another pnpm install lock.
The outer persistent custody control adds consumer lifetime/readiness and
retirement admission across backends; the existing cache-root control alone
does not supply those guarantees.
Native editor generation leases or pins remain required for exported snapshots,
including protection against host-budget collection outside this checkout.

The outer lease is deliberately conservative: in-place legacy setup cannot run
while any admitted consumer reads. Atomic publication is retained inside this
boundary, not used as an excuse to mutate around legacy readers.

## Lifecycle and readiness (R05/R06)

```text
absent -- custodian obtains exclusive lease --> installing -- verified --> ready
installing -- failure / interruption --> stale -- custodian repair --> installing
ready -- missing, changed, or invalid evidence --> stale
```

| State      | Meaning                                                                    | Consumer behavior                                                                   |
| ---------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| absent     | Checkout or initial setup evidence does not exist                          | Request materialization/readiness; no consumer install                              |
| installing | Custodian holds exclusive lease and has invalidated ready evidence         | Wait with a caller-supplied deadline; cancellation stops waiting, not the custodian |
| ready      | Matching evidence and exports pass validation while a shared lease is held | Link and run under that lease                                                       |
| stale      | Failed/interrupted setup, mismatched identity, or invalid evidence         | Report reason and request repair; never use partially installed state               |

These are derived states, not a trusted status-string cache. A surviving
`installing` record without an exclusive holder is stale. Lock contention alone
may be an active reader, so status must distinguish a waiting writer from an
installing custodian. A missing record after interrupted setup is not ready.

The required coordinator offers **request**, **status/wait**, and **run with
readiness lease** operations; these names describe an interface, not shipped CLI
commands. Requests contain the canonical root, full expected Git commit, exact
package/version/export requirements, runtime/platform identity, and deadline.
Concurrent equivalent requests coalesce; incompatible requests fail rather than
upgrading the pinned checkout or changing its dependency inputs.

Custodian setup sequence:

1. Resolve/materialize the commit checkout through the store owner; verify HEAD
   equals the requested commit and authored inputs match that commit. Never
   reset, clean, repin, or convert a branch checkout to satisfy a request.
2. Obtain the exclusive custody lease, then repeat root/commit/input validation.
   Invalidate the old ready record before any mutation and record the operation
   identity, custodian, backend, and phase for status diagnostics.
3. Select the revision's supported backend. Current revisions use scoped Buck
   editor publication and declaration publication only when requested. An older
   revision may use its managed frozen-lockfile install **only if that revision
   exposes and supports it**. No raw `pnpm install` fallback or implicit scripts.
4. Validate every requested export, its exact package version and resolved
   containment, plus a runtime import/native-ABI smoke probe where applicable.
   Verify dependency-input fingerprints and publication evidence again. A path's
   existence or matching HEAD alone is insufficient.
5. Atomically rename a complete readiness record beside the persistent control,
   then release exclusivity. Ready evidence covers only its declared exports;
   extending that set requires another exclusive, verified operation.
6. Consumer acquires a shared lease and revalidates the record and exports before
   use. Do not assume exclusive-to-shared conversion is atomic: any reacquisition
   gap requires full revalidation. Keep the shared lease through runtime exit.

The repository-local readiness format is owned by effect-utils. Version 1 uses
integer `version: 1`, `root`, `commit` (40 lowercase hex), `inputDigest` (SHA-256,
64 lowercase hex), `backend` (`buck` or `managed-pnpm`), `platform` (OS, CPU and
runtime ABI), and `exports` (package name, exact version, root-relative lexical
path, canonical target, and backend integrity/generation identity). The digest
covers manifests, lockfile, patches, install policy/tool pins and generated
publication authority used by that backend. Backend and record version are
separate axes. Unknown versions/backends fail closed; additive unknown fields
are ignored. Root-relative paths reject absolute paths and `..`; canonical
targets must remain within the admitted checkout or backend-declared immutable
store roots. JSON is UTF-8; no timestamps substitute for input/content proof.
Invalid examples include an abbreviated commit, an unknown backend, or an
export escaping through an undeclared symlink. No public URI namespace is added.

## Export compatibility and consumer prohibitions (R06)

A legacy target such as
`node_modules/.pnpm/oxc-parser@<version>/node_modules/oxc-parser` is a
revision-specific layout detail, **not** a stable effect-utils export. A
custodian may admit it only for a supported legacy backend with exact version,
link-target and runtime verification. Current Buck publication does not promise
a root `.pnpm` tree. Unsupported layout requests fail explicitly; consumers must
request an admitted package export rather than synthesize a guessed store path.
This draft adds no dependency or version absent from the pinned revision.

Consumers must never:

- Run install/bootstrap, regenerate files, repair, clean, or publish into the
  shared checkout without assigned custody and exclusive admission.
- Race a custodian, bypass managed mutation guards with raw package-manager
  commands, or infer permission from PNPM_HOME selection, `refs/commits`,
  successful prior setup, a stale receipt, or lock age.
- Delete lock files, kill another holder, run `rm -rf` or `chmod -R` on a shared
  checkout, or change modes through hardlinks into the shared content store.
- Keep reading a linked payload without custody and applicable generation
  retention, or silently switch to another revision/backend after a failure.

## Failure, recovery, and required implementation

| Failure                                           | Recovery owner/action                                                                                                                          |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Wait deadline, live reader/writer                 | Consumer returns state/reason and request identity; custodian remains untouched                                                                |
| Custodian crash                                   | Kernel closes custody descriptors only after surviving children exit; next exclusive holder marks evidence stale and re-verifies before repair |
| Stale editor publication lock                     | Custodian uses existing identity/token-gated recovery; outer flock does not replace that proof                                                 |
| Missing native package, export, or policy support | Custodian reports unsupported request; no guessed version/install fallback                                                                     |
| Corrupted/unsafe shared payload                   | Stop admission; custodian uses supported repair and existing reader/quiescence proofs, never recursive permission changes                      |
| Retirement                                        | Store/teardown owner obtains exclusive custody plus existing keep/activity/reader proofs; preserve the persistent control                      |

Required implementation steps (not delivered by this spec-only change):

1. Add the native custody wrapper and record codec using the existing flock and
   descriptor-inheritance pattern; canonical identity and safe-open checks are
   mandatory before exposing consumer admission.
2. Add request coalescing, bounded waiting/status, backend selection, complete
   readiness verification, and atomic record publication. Define the exact
   public CLI spelling with its implementation, without advertising stubs.
3. Integrate all mutation, store retirement, and teardown paths; adapt consumers
   to request exports, create only local links, and launch under retained leases.
4. Add concurrency, interrupted setup, inherited-child lifetime, stale evidence,
   unsafe control, unsupported-layout, native import, and retirement-race tests.

**DQ1 Legacy backend admission:** Which pinned revisions still expose a supported
managed materialization task? Resolve by inspecting each requested revision;
this specification does not grandfather arbitrary frozen-lockfile installs.

**DQ2 Public adapter placement:** Select the existing native tooling package that
owns request transport and its installed launcher. Resolve with the implementation
review; custody semantics and fail-closed behavior do not depend on its CLI name.
