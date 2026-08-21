# Experiment: JSX → Notion-enhanced-Markdown prototype validation

- **Date:** 2026-08-21
- **Related:** decision 0001, issue #1097

## Question

Can a read-only Markdown projection share the production render/tree
semantics, produce deterministic review-grade output with typed diagnostics,
and compose with `renderNmdFile` — without touching the pull-side wire
renderer?

## Method

Prototype implementation at `src/markdown/render-to-notion-markdown.ts`
walking `buildCandidateTree` output; 16 golden unit tests (headings,
paragraphs, inline annotations, links, mentions, equations, per-run numbered
lists, nested lists, to-dos, `<details>` toggles, quotes, callouts, code
fences, GFM tables with header separator, dividers, block equations, TOC,
page links, external media, bookmarks, embeds, upload-only media diagnostics,
column flattening, child-page flattening, Raw placeholders, determinism); 1
composition test driving the real `renderNmdFile`; end-to-end scratch run
producing a full `.nmd` file compared against #1097's canonical example.

## Result

Confirmed. Full package suite green (335 tests incl. new); `check:quick`
(ts + lint + genie) green after export/devDep wiring. Diagnostics fire for
color drops, upload-only media, flattened columns/child pages, and
unsupported Raw blocks. Determinism holds across repeated renders; the body
matches #1097's canonical example.

Facts established along the way:

- Media captions are a component _prop_ (`caption={...}`), not children —
  children of media components are ignored by the host projection.
- `bookmark`/`embed` project a bare `url` prop; file-like media project
  `type: 'external' | 'file_upload'` envelopes.
- The mention dialect renders `@{plain_text}` (plainText excludes the `@`),
  matching `RichTextUtils.toMarkdown`.
- `RichTextUtils.toMarkdown` silently drops non-default colors; the projector
  instead emits `color-dropped` diagnostics.
- `renderNmdFile` appends a trailing newline after the body.

## Conclusion

Ship the projection as an experimental entry point per decision 0001. The
dedicated-projector architecture meets every #1097 acceptance criterion that
is testable offline; the Blocky consumer proof remains open per the demand
gate.

## VRS Impact

Spec gains the "Markdown projection (read-only, experimental)" section;
decision 0001 records the consolidated Q1–Q7 choices; fidelity matrix facts
above feed future spec expansion when the second consumer lands.
