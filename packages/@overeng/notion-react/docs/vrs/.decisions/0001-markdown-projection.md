# 0001 — Dedicated CandidateTree Markdown projector, structured result, drop-with-diagnostics fidelity

Date: 2026-08-21

Status: accepted

Deciders: schickling (delegated via "do all remaining work"), ox-alpha (evidence + recommendation)

## Context

#1097 asks for a read-only JSX → Notion-enhanced-Markdown projection for
review artifacts, CLI previews/exports, and optional `.nmd` envelope
composition. The workspace already contains a blocks→Markdown serializer
(`NotionMarkdown.treeToMarkdown` in `@overeng/notion-effect-client`, the
pull-side wire renderer), so architecture, return shape, naming, fidelity
policy, stability status, composition-test placement, and VRS shape all
needed settling. Seven decision requests were recorded in the axe decision
tree (Q1–Q7) with grounded options; the user delegated the remaining work,
so each was assumed on the evidence-backed recommendation.

## Options

| Q                   | Option                                        | Chosen        | Grounding                                                                                                               |
| ------------------- | --------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Q1 architecture     | dedicated CandidateTree projector             | yes           | prototype green (experiment 0001); delegation cannot meet typed-diagnostics criterion without pull-side wire-drift risk |
| Q1 architecture     | delegate to `treeToMarkdown`                  | no            | no diagnostics channel, silent unknown-type drop, hardcoded `"1."`, non-GFM tables (source read 2026-08-21)             |
| Q1 architecture     | dedicated now, extract shared spellings later | yes (variant) | demand gate: centralize when second consumer justifies                                                                  |
| Q2 return shape     | structured `{body, diagnostics}`              | yes           | bare string cannot satisfy #1097 diagnostics acceptance criterion                                                       |
| Q2 return shape     | bare string                                   | no            | side-channel warnings untestable, non-composable                                                                        |
| Q3 naming           | `renderToNotionMarkdown` at `./markdown`      | yes           | #1097 proposed API verbatim; mirrors `renderToNotion` + `./web` patterns                                                |
| Q4 fidelity         | drop-with-diagnostics                         | yes           | dialect-consistent (`RichTextUtils.toMarkdown` drops colors); body stays clean review artifact                          |
| Q4 fidelity         | HTML fallbacks                                | no            | dialect-divergent, noisy diffs                                                                                          |
| Q4 fidelity         | fail-closed                                   | no            | unusable for real documents (colors are common)                                                                         |
| Q5 stability        | experimental                                  | yes           | #1097 demand gate: narrow until Blocky proof + fidelity matrix + second consumer                                        |
| Q6 composition test | react devDep on notion-md, colocated test     | yes           | exercises real `renderNmdFile`; manifest coupling only; forbidden reverse direction not created                         |
| Q7 VRS shape        | extend notion-react docs/vrs                  | yes           | owning-artifact locality; new subsystem root is overkill                                                                |

## Evidence and Argument

- Prototype (experiment 0001, 2026-08-21): a dedicated CandidateTree walker
  passed 16 golden tests plus the full package suite and produced #1097's
  canonical example byte-for-byte; composition with the real `renderNmdFile`
  verified end-to-end.
- Source read of `notion-effect-client/src/markdown.ts` (2026-08-21): no
  diagnostics channel (`unsupported: () => ''`), hardcoded `"1."` numbering,
  table rows without a GFM header separator — delegation cannot meet the
  typed-diagnostics acceptance criterion without invasive pull-side changes
  risking `.nmd` wire drift.
- `RichTextUtils.toMarkdown` drops non-default colors silently; HTML-span
  color fallbacks appear nowhere in the workspace dialect, so
  drop-with-diagnostics is the consistent policy.
- #1097's demand gate requires narrow-and-experimental until consumer proof;
  its non-goals forbid notion-md→notion-react coupling and production
  frontmatter/settlement semantics in notion-react (a devDependency used by
  one test creates neither).

## Decision

1. Dedicated serializer over the shared `CandidateTree` inside
   `@overeng/notion-react/src/markdown/`; spellings aligned with the pull-side
   dialect where sound; centralization deferred until a second consumer.
2. Structured result `{ body, diagnostics }`.
3. `renderToNotionMarkdown` at `@overeng/notion-react/markdown`.
4. Drop-with-diagnostics fidelity: colors dropped with diagnostics; `blockKey`
   absent from the body; toggleable headings flatten with diagnostic; child
   pages flatten to bold label + content with diagnostic; unsupported/`Raw`
   blocks emit HTML-comment placeholders + diagnostics.
5. Explicitly experimental surface (`@experimental` JSDoc, docs, CHANGELOG).
6. `@overeng/notion-md` as devDependency of `@overeng/notion-react` with a
   colocated composition test; production imports stay clean.
7. VRS extends this package's docs/vrs (spec section, this record, experiment
   0001).

## Consequences

- Two spelling tables exist (push-side review projection, pull-side wire
  renderer); golden tests pin the review dialect and drift is an accepted cost
  until centralization.
- The body is a review artifact only: no CacheTree identity, sync safety, or
  round-trip claims may be derived from Markdown equality (#1097 non-goals).
- Diagnostics kinds are an open set (`unsupported-block`, `media-without-url`,
  `color-dropped`, `flattened` today); growth is additive while experimental.
