# Requirements: 02-file-sync

**Role.** The file-based sync surface and its orchestration: the pull / status /
push flows over a persistent `.nmd` file, watch-mode lifecycle, and the
batch/tree orchestrator (target discovery, duplicate page-id preflight, bounded
concurrency, per-file results). One `.nmd` file maps to one Notion page; every
mutation passes through the shared page-local guards in
[03-sync-engine](../03-sync-engine/requirements.md).

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved. The
guarded-push / three-way-merge / settle engine this surface calls is owned by
[03-sync-engine](../03-sync-engine/requirements.md) (R09, R11, R13, R15); the
file/property-surface bits of R11/R13 are exercised here but defined there.

## Requirements

### Must coordinate file-based sync safely

- **R20 Bounded concurrency:** Watch mode must serialize or intentionally coordinate sync passes so local writes, remote writes, and state-store updates cannot overlap unsafely.

### Must preserve tree authority and ownership

- **R51 Tree authority dispatch:** Tracking an existing Notion page into an existing directory must materialize its complete child-page subtree and persist explicit `remote` authority in the tree manifest. Later non-recursive `status` and `sync` calls must dispatch from that manifest; file calls continue to dispatch from frontmatter `source`. New local tree manifests must persist `local`, while manifests without authority normalize to `local` at the read boundary. Tracking a different root into an established tree must refuse rather than repurpose the workspace.
- **R53 Ownership-safe remote reconciliation:** A remote-authoritative tree must refresh page content and reconcile remote additions, page-ID-preserving path moves, and removals. The manifest is a derived routing and prior-ownership index, never page identity: an existing destination may be replaced only when its frontmatter identifies the incoming page or the manifest-recorded occupant, and a stale path may be removed only when both the prior manifest and current frontmatter identify the expected page. Unknown, rebound, identity-less, and unrelated local files must be preserved or refused, never overwritten or deleted. A dry run must perform every remote read, completeness check, child-anchor validation, and ownership check that apply would perform while writing nothing.
- **R55 Derived child links:** Remote tree materialization must render direct child-page navigation as relative Markdown links in local files while keeping canonical Notion child anchors in the sync baseline. Those links are derived only inside a remote-authoritative tree; a local-authoritative tree must preserve a user-authored Markdown link even when its href matches a child path.

### Must verify watch behavior

- **R28 Watch coverage:** Watch mode must be tested for debounce, coalescing, cancellation, overlapping events, remote polling, and shutdown.
