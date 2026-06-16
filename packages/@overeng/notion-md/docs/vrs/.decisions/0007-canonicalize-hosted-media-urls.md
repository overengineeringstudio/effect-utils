# Hosted-media URLs are canonicalized (signature stripped) everywhere bodies are hashed, diffed, or gated

Notion-hosted media blocks (image/file/video/pdf with `type: "file"`) render as
`![caption](<signed-url>)`, and the signed S3 URL (`X-Amz-Signature/Credential/
Expires/Security-Token…`) **rotates on every pull**. External-URL media is
stable. Live testing (experiments.md, items 3/6c/7) showed this single fact
breaks the streaming surface three ways:

- raw body hash differs between two no-op pulls → `cat`→`put` non-idempotent and
  the base hash goes stale within the URL TTL with zero edits;
- a stored base hash is unusable for media pages;
- `update_content` pushes on a media page are **rejected** by the gateway's
  post-push gate, because `semanticEquivalent` does whitespace-only
  normalization and the re-observed rotated URL ≠ the expected body.

Decision: **canonicalize hosted-media URLs** — strip the volatile
`X-Amz-*` / signature / `Expires` query params, keep `origin + pathname` — at
every point a body is hashed, diffed, base-tracked, or gated, **including inside
`semanticEquivalent`**. External (stable) URLs are left untouched. This is the
chosen fix over an opaque `notion-file:<id>` placeholder reference: it is
simpler, keeps Markdown image syntax, was validated to make the body hash stable
(`b02e7f27` across both pulls), and reuses the existing renderer/diff path.

## Status

accepted

## Consequences

- The renderer (or a post-render canonicalization step) must emit the
  signature-stripped URL for hosted media so `cat` output is deterministic.
- `canonical-markdown.ts` `canonicalizeBlockMarkdown` / `semanticEquivalent`
  must URL-canonicalize, not just normalize whitespace — otherwise every
  `update_content` push on a media page fails closed (item 6c).
- The canonicalized URL is stable but not directly fetchable; that is accepted
  for an editing surface (the user edits text, not media URLs). Canonicalization
  is for **hashing / diffing / gating** only. Whether a canonicalized URL
  survives a full `replace_content` round-trip is an implementation-verification
  item (the live file stays authoritative on the remote); it does not change the
  hashing contract.
- The hashed, human-visible body never carries volatile data — the same
  no-volatile-data-in-the-hash principle the design applies throughout.
