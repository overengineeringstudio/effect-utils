# Streaming surface scope: body + writable projection only; other surfaces stay file-based

> **Refined by [0017](./0017-edit-is-an-ephemeral-file-engine-session.md):** this
> scope boundary now applies to the **stateless pipes `cat`/`put`** only; `edit`
> is an ephemeral file-engine session that widens reach on representable pages.

The streaming surface (`cat`/`put`/`edit`) is stateless — no `.notion-md/`, no
sidecar, no object store. It therefore operates on exactly the **writable
projection** (decision 0006): body + title + writable metadata + writable
properties. Everything else stays on the file-based path (`sync`/`status`/
`plan`):

- **File bytes / object store:** no download or upload; hosted files stay
  remote-authoritative and are referenced by canonicalized URL (decision 0007).
  (Originally this also covered an inline placeholder for non-representable media;
  that placeholder approach was abandoned for refuse-lossy — decision 0016.)
- **Comments, data-source schema, unsupported-block payload snapshots,
  base-snapshot three-way merge, tree / child-page operations:** file-only.

This is a **scope boundary, not a refusal**: those surfaces simply are not
represented in the stream, so editing a page's body/title through streaming
leaves them untouched on the remote. A user who needs to edit one of those
surfaces uses the file-based path.

## Status

accepted

## Consequences

- Streaming never triggers object-store overflow (it carries no storage
  payload), so there is no overflow case to refuse — the earlier "overflow out
  of scope" note in decisions 0006/0007 is subsumed here.
- The file-based and streaming surfaces are complementary views of the same
  page, not competing ones; guidance should point users to `sync` when they need
  a surface outside the projection.
