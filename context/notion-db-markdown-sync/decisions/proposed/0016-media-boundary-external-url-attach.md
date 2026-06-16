# Files/media boundary: external-URL attach (already works), hardened

Status: proposed

Contrary to follow-up 0012's F3 wording ("structural-only / does not genuinely
attach"), external-URL file attach ALREADY works end to end on the PROPERTY
surface. An `external_url` `NmdPropertyFileRef` encodes to a real Notion
external-file property write (`@overeng/notion-md/src/sync.ts:339`, proven by
`sync.e2e.test.ts:1284`). This record corrects that premise up front and decides
how to harden the boundary rather than how to build something that already
exists.

The property-encoding boundary and the media boundary are cleanly DISJOINT by
type. The property boundary is `NmdPropertyFileRef` with three variants —
`local_file`, `notion_file`, `external_url`. The media boundary is `NmdFileUnit`,
which is byte-backed and has NO external variant by construction
(`media-boundary.ts` `guardMediaWrite`). Because the two boundaries share no
type, external URLs never enter `storage.files`. Durability of the media surface
therefore holds "by construction" — but only while no code lowers an external or
local property ref into a byte unit. That invariant is currently enforced by
absence, not by a guard.

## Decision

Take Option B — harden the existing boundary and wire the dormant guard, in
three parts.

(1) Make the "inert-means-durable" invariant EXPLICIT and ENFORCED. Add a
fail-closed assertion/guard at the point where a property file-ref would be
lowered into a `storage.files` byte unit, so an `external_url` or `local_file`
ref can NEVER silently ride the byte path. This subsumes F4's `local_file`
guard re-siting: `local_file` already fails closed at `sync.ts:355`, and that
posture is preserved, but the load-bearing guard moves to the byte-path lowering
seam so it pre-empts a future lower-to-byte path rather than guarding one layer
up.

(2) Wire the currently-dormant `ExpiringFileUrl` guard. It is defined at
`core/guards.ts:514` and unit-tested, but has NO production dispatch. Wire it
into the production property-write path so a Notion-hosted expiring URL pulled
into a property is caught rather than silently written as a soon-dead link.

(3) Take an explicit external-URL DURABILITY stance. External URLs can 404 or
move. v1 attaches them as-is and does NOT verify their durability. This is
stated as a known content-fidelity limitation — the external analog of
`ExpiringFileUrl`, but with no guard — rather than left implicit. Byte
upload/replace/delete stay fail-closed: `DurableFileUploadUnsupported` and
`DurableFileWriteUnsupported` are wired; `DurableFileReplacementUnsupported` and
`DurableFileDeletionUnsupported` are declared with no call site.

The honest v1 headline is "external-URL attach PLUS pre-uploaded `notion_file`
(with `file_upload_id`)", not strictly external-only.

## Evidence

A validation agent traced that external-URL attach already works on the property
path (`sync.ts:339`, `sync.e2e.test.ts:1284`), that the media seam already exists
(`guardMediaWrite`), that `local_file` already fails closed (`sync.ts:355`), and
that `ExpiringFileUrl` is defined but dormant — present as a placeholder scenario
with no production dispatch.

## Considered Options

| Option                                                                          | Result   | Reason                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Doc-correction only, defer hardening                                            | Rejected | Leaves the inert-by-absence invariant unenforced; a future refactor could silently route an external URL through the byte path.                                                                                    |
| Harden invariant + re-site `local_file` guard, defer ExpiringFileUrl/durability | Rejected | Closes the latent risk but leaves the property-surface expiring-URL hole and the external-URL durability stance unstated.                                                                                          |
| Harden invariant + wire ExpiringFileUrl + durability stance (Option B)          | Selected | Closes the latent byte-path risk AND the property-surface expiring-URL hole, and makes the external-URL durability limitation explicit. Honors the efficiency NFR — external URLs carry no bytes, by construction. |

## Consequences

- Three hardening items land: (1) a fail-closed byte-path lowering guard, (2)
  `ExpiringFileUrl` wired into the production property-write path, (3) an
  explicit external-URL durability limitation in the content-fidelity record.
- The byte-path lowering guard is the load-bearing invariant: it is what makes
  "inert means durable" true under future refactors rather than true only by the
  current absence of a lowering path.
- F2's object dry-run rides on this boundary — the same disjoint property/media
  split is what lets a dry-run suppress object/attachment writes.
- Residual NDS-side wiring remains if datasource-sync property writes are to
  carry external refs: the guard and the `ExpiringFileUrl` dispatch are decided
  on the `@overeng/notion-md` property path, and the datasource-sync side would
  need to route through it.
