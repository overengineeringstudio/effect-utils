# Files/media boundary: external-URL attach (already works), hardened

Status: accepted

Contrary to follow-up ledger's F3 wording ("structural-only / does not genuinely
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

Take Option B — harden the existing boundary and wire the property-file
durability guard, in three parts.

(1) Make the "inert-means-durable" invariant EXPLICIT and ENFORCED. Add a
fail-closed assertion/guard at the point where a property file-ref would be
lowered into a `storage.files` byte unit, so an `external_url` or `local_file`
ref can NEVER silently ride the byte path. This subsumes F4's `local_file`
guard re-siting: `local_file` already fails closed at `sync.ts:355`, and that
posture is preserved, but the load-bearing guard moves to the byte-path lowering
seam so it pre-empts a future lower-to-byte path rather than guarding one layer
up.

(2) Wire the `ExpiringFileUrl` guard into the production property-write path so
a Notion-hosted expiring URL pulled into a property is caught rather than
silently written as a soon-dead link.

(3) Take an explicit URL-DURABILITY stance — durability is a property of the
URL, NOT of its source. The guard does not ask "is this URL Notion-hosted vs
external"; it asks "does this URL expire". Two cases fail closed alongside each
other:

- a Notion-hosted file (no `externalUrl`) — its signed link is not captured as
  durable identity (part 2 above); and
- an OBVIOUSLY-expiring EXTERNAL URL — an S3 presigned link
  (`X-Amz-Signature`/`X-Amz-Expires`/`X-Amz-Credential`), an Azure SAS (`sig`
  with `se`/`st`), a GCS signed URL (`X-Goog-Signature`/`X-Goog-Expires`), or a
  generic presign/expiry shape (`Signature`+`Expires`, a unix-ts `Expires`,
  `token`+`exp`). A pure `isExpiringExternalUrl(url)` helper
  (`planner/property-proof.ts`) detects these and routes them through the SAME
  `ExpiringFileUrl` guard.

This closes the source-vs-durability asymmetry: previously any `externalUrl`
was treated as durable, so a presigned external link was attached as "durable"
even though it expires just like a Notion-hosted signed link.

Detection is deliberately CONSERVATIVE — only clear presign/expiry signatures
are flagged, to avoid false-positives on durable URLs that merely carry benign
query params (`?utm_source=…`, `?v=2`, a bare `?token=` API key with no expiry).
The cost of conservatism is the residual below.

Residual limitation: only OBVIOUS expiry signatures are detectable. Non-obvious
non-durability stays undetectable — a plain durable-looking URL
(`https://example.com/file.pdf`) that 404s or moves tomorrow carries no signature
the guard can read, so it is attached as-is and NOT verified. A malformed /
non-parseable URL likewise carries no detectable signature and is treated as
durable (fail-open in the SIGNATURE detector — `isExpiringExternalUrl` returns
`false` and never throws); the notion-hosted no-`externalUrl` path still fails
closed independently. This is the external analog of `ExpiringFileUrl`'s
content-fidelity limit, now partially guarded rather than left implicit. Byte
upload/replace/delete stay fail-closed: `DurableFileUploadUnsupported` and
`DurableFileWriteUnsupported` are wired; `DurableFileReplacementUnsupported` and
`DurableFileDeletionUnsupported` are declared with no call site.

The honest v1 headline is "external-URL attach PLUS pre-uploaded `notion_file`
(with `file_upload_id`)", not strictly external-only.

## Evidence

A validation agent traced that external-URL attach already works on the property
path (`sync.ts:339`, `sync.e2e.test.ts:1284`), that the media seam already exists
(`guardMediaWrite`), that `local_file` already fails closed (`sync.ts:355`), and
that `ExpiringFileUrl` is the right production guard for property-file URL
durability.

## Considered Options

| Option                                                                          | Result   | Reason                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Doc-correction only, defer hardening                                            | Rejected | Leaves the inert-by-absence invariant unenforced; a future refactor could silently route an external URL through the byte path.                                                                                    |
| Harden invariant + re-site `local_file` guard, defer ExpiringFileUrl/durability | Rejected | Closes the latent risk but leaves the property-surface expiring-URL hole and the external-URL durability stance unstated.                                                                                          |
| Harden invariant + wire ExpiringFileUrl + durability stance (Option B)          | Selected | Closes the latent byte-path risk AND the property-surface expiring-URL hole, and makes the external-URL durability limitation explicit. Honors the efficiency NFR — external URLs carry no bytes, by construction. |

## Consequences

- Three hardening items land: (1) a fail-closed byte-path lowering guard, (2)
  `ExpiringFileUrl` wired into the production property-write path, (3) the
  durability stance reframed as a URL property not a source property —
  obviously-expiring external URLs (presigned/SAS/signed-URL signatures) fail
  closed alongside Notion-hosted via `isExpiringExternalUrl`, with non-obvious
  non-durability documented as the residual content-fidelity limit.
- The byte-path lowering guard is the load-bearing invariant: it is what makes
  "inert means durable" true under future refactors rather than true only by the
  current absence of a lowering path.
- F2's object dry-run rides on this boundary — the same disjoint property/media
  split is what lets a dry-run suppress object/attachment writes.
- Residual NDS-side wiring remains if datasource-sync property writes are to
  carry external refs: the guard and the `ExpiringFileUrl` dispatch are decided
  on the `@overeng/notion-md` property path, and the datasource-sync side would
  need to route through it.
