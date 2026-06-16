# Title is presented as a leading H1, but always transported through the typed title API

Default streaming mode renders the page title as a leading `# <title>` line so a
human can edit it as normal Markdown. This looks like it violates R04 (properties
must sync through typed APIs, not body Markdown) — but it does not, because the
H1 is a **presentation** affordance only.

The hard rule: on `put`, the leading title H1 is parsed out, the title is written
through the typed page-metadata API (`updatePageMetadata`), and the H1 is
**stripped from the body** before the body is pushed. The body sent to Notion
stays stock enhanced Markdown (R01), and the title never travels as a body block
(R04). R01/R03/R04 govern the _transport_ surface; presentation is unconstrained.

## Status

accepted

## Consequences

- The base-hash guard must cover title + body together (a title change is a
  document change), not the body alone.
- `cat`/`put` default mode must canonicalize the title-H1 boundary identically
  so the round-trip is idempotent.
- Edge rules (line 1 not an H1, body's own leading H1, untitled page) are
  specified in spec.md and refined in later decisions.
