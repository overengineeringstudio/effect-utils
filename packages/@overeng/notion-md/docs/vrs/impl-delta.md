# Implementation Delta

What the spec (the full long-term target) describes vs. what
`@overeng/notion-md` and the `notion` umbrella currently implement. The design is
**refuse-lossy, one engine** (decisions 0016, 0017): the editor serves the
representable-Markdown majority and refuses pages with opaque blocks uniformly;
`cat`/`put` are stateless body pipes and `edit` is sugar over the existing file
`sync` engine. The work groups below are dependency-ordered.

## Already in place (reuse, don't rebuild)

- **File `sync` engine** — `pullPage` / `syncPage` / `statusPage` (`sync.ts`) are
  fully location-relative (state paths derive from the `.nmd` path arg, no
  `process.cwd()`), already exercised in `mkdtemp` dirs by the live suite. `edit`
  reuses this wholesale — pull to `$TMPDIR`, splice, `syncPage`, cleanup.
- **Body facade** — `observeRemoteBody` / `replaceRemoteBodyVerified` are
  gateway-only and need no file/store. This is the whole `cat`/`put` push engine —
  no block-level reconciliation.
- **Page id / URL resolution** — `parseNotionUuid` (`@overeng/notion-core`)
  accepts raw ids, dashed ids, and full Notion URLs.
- **Frontmatter envelope** — `renderNmdFile` / `parseNmdFile` round-trip the
  `.nmd` envelope purely (the body-only splice for `edit`).
- **Unsupported-block accounting** — `NmdUnsupportedBlockUnit` /
  `unsupported_blocks` (no `NmdnUnit` / `n_blocks`); the body-fidelity classifier
  flags only `unsupported` (`body-fidelity.ts:45`) — **the latent bug Group C
  fixes**; the gateway has `updateMarkdown`, `updatePageMetadata`,
  `updatePageProperties`.

## Group A — editor surfaces `cat` / `put` / `edit`

Spec: "Editor Surfaces". Requirements: R32–R35, R37, R39.

- [ ] `cat <page> [--frontmatter]` — default `# <title>` + body; base hash to
      stderr (decision 0002); reuse `observeRemoteBody`; `--frontmatter` is a
      read-only envelope dump; **refuse a lossy page (exit 3) at read time** (Group C).
- [ ] `put <page> (--base-hash <h> | --force)` — body + title only (no
      `--frontmatter` write, decision 0017); title H1 → typed title API + stripped
      from body (decision 0001); guarded by default; `--force` concurrency-only
      (decision 0009); **two writes, body (`replaceRemoteBodyVerified`) first,
      title last, partial-failure reported** (decision 0012, exit 10).
- [ ] `edit <page> [--frontmatter]` — **thin wrapper over the engine** (decision
      0017): `mktemp -d` under `$TMPDIR` → `pullPage` → body-only splice → `$EDITOR`
      → reattach → `syncPage` (force full `replace_content`) → relocate any
      `.conflict.roughdraft.md` out of `$TMPDIR` → scope-clean. No bespoke push
      path, no base-hash threading, no partial-write model.
- [ ] Shared `<page>` resolution (`parseNotionUuid`) and the title↔H1 splice
      helper (used by `cat`/`put` and `edit`); fail-loud on missing title H1;
      exact untitled/empty-body bytes (spec edge behavior).

Prototype (validated, not production): `tmp/notion-vim/` — `pagemd-live.ts`,
`notion-md-edit.sh`.

## Group B — hosted-media URL canonicalization

Spec: "Hosted-Media References". Decision 0007. Requirement: R36. Shared by both
surfaces. Live testing (experiments.md) showed media-bearing pages are otherwise
non-idempotent and their pushes are rejected by the post-push gate.

- [ ] Canonicalize hosted-media URLs (strip `X-Amz-*`/signature/`Expires`, keep
      origin+path) everywhere a body is hashed/diffed/base-tracked.
- [ ] Apply the same canonicalization **inside** `semanticEquivalent` /
      `canonicalizeBlockMarkdown` (`canonical-markdown.ts`) — currently
      whitespace-only (`:95`), so any media-page push is rejected today.
- [ ] Leave external (stable) URLs untouched.

## Group C — sound fidelity classification (the shared refusal gate)

Spec: "Refusing Lossy Pages (uniform)". Decisions 0016, 0017. Requirement: R38.
**Blocking prerequisite** — and a correctness fix for the existing file path, not
just streaming.

- [ ] Extend the classifier beyond `unsupported` to flag every
      not-losslessly-round-trippable block (`child_database`, `table_of_contents`,
      `synced_block`, `child_page`, …). Today these classify `complete` with empty
      `unknown_block_ids`, so a `replace_content` (file `sync` or `edit`) silently
      destroys them (`body-fidelity.ts:45`, `assertRemoteMarkdownComplete`
      `sync.ts:567`).
- [ ] Because the gate is at the pull (`assertRemoteMarkdownComplete`), the
      refusal then covers `cat`/`put`/`edit`/`sync` uniformly with the same code —
      exit 3, message naming the block class, pointing to the Notion UI.

## Group F — `--frontmatter` schema-drift, via the engine (not a fingerprint)

Spec: "Guard plumbing". Decision 0017 (supersedes 0013). Requirement R14. The
stateless in-buffer fingerprint is **deleted**; `edit --frontmatter` detects drift
from a base snapshot, the same way the engine detects body conflict.

- [ ] Capture the writable data-source schema into the engine sidecar as a
      `schema_snapshot` (an already-designed object role) at `pullPage`, and
      compare it at `syncPage` push, refusing a property write on drift (R14).
      This is a small file-engine addition, not a parallel streaming subsystem.

## Group G — error model + observability + tests

- [ ] Tagged errors → exit codes (spec table): gateway failure (1), **lossy-page
      refusal (3)**, schema drift (6, `edit --frontmatter`/`sync`, engine
      `schema_snapshot`), conflict (7), editor abort (8), post-push gate (9),
      partial write (10, `put` only). No exit 11.
- [ ] OTEL: `notion-md.cat|put` spans (mode, result, page id, `body_written`/
      `title_written`); `notion-md.edit` wraps the engine's `sync-page`/`push-page`/
      `status-page` spans (R21–R24; no tokens/bodies/signed URLs).
- [ ] Unit (title↔H1 split, base-hash, lossy-classifier verdicts), integration
      (fake gateway incl. refusal path), live E2E (round-trip, conflict, media,
      lossy-page refusal, ephemeral `edit` over the engine) — R25–R29.

## notion-cli (umbrella)

Decision 0004. Spec: "Umbrella surface". Requirements R17–R18.

- [ ] `notion md cat|put|edit` via existing dispatch — verify.
- [ ] Promote top-level alias `notion edit <page>`.
- [ ] Update notion-cli docs (already reflect the surface; keep in sync).

## Dependency order

C (the shared refusal gate) is the blocking prerequisite — it gates the pull on
every surface and fixes the latent file-path bug. B (media) makes representable
bodies idempotent. A is the surface: `cat`/`put` over the body facade, `edit` a
thin wrapper over the `sync` engine. F is a small engine addition for
`--frontmatter` drift. G spans everything. The reconciler/converter groups and the
stateless schema-fingerprint group are gone (decisions 0016, 0017).
