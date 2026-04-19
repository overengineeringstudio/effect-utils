# Docs Structure Proposal — `@overeng/notion-react`

Draft for team-lead review. Goal: pick a docs layout and rendering strategy
before seeding a skeleton and backfilling content.

## Context

- Package is internal-first, but shaped for potential open-source release.
- Small maintainers team; appetite for tooling should be low.
- Storybook is already present (`src/web/*.stories.tsx`) with a
  Nimbus Smart Lamp visual theme.
- VRS docs live in `context/vrs/` and are source-of-truth for design.
- README.md is already dense (Getting Started, `blockKey` vs `key`, key
  invariants) — risks becoming the kitchen sink.
- Effect ecosystem convention: concept-first prose + hand-written examples,
  TSDoc on the public surface.

## Prior art scanned

| Library           | Structure                                                                 | Takeaway                                                                          |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| react-three-fiber | Docusaurus site: Getting Started → API → Tutorials → Advanced → Recipes   | Strong "concept → API → cookbook" progression; search matters for a big surface.  |
| ink               | Single long README + `examples/` dir                                      | Works for small, opinionated surface. Breaks down as API grows.                   |
| react-pdf         | Standalone site + `examples/` repo                                        | Keeping runnable examples separate from prose scales well.                        |
| Effect            | Concept guides + TSDoc + effect.website                                   | Concept-first; separates "learn" from "reference".                                |
| Storybook         | MDX docs co-located with stories; docs-mode rendered site                 | Great when components are the unit of docs. Poor for cross-cutting concepts.      |

What good docs have that we're missing:
- A clear "concepts" layer between Getting Started and API reference
  (invariants, key model, reconciler semantics) — currently stuffed in README.
- A cookbook / recipes surface (custom blocks, theming, Nimbus vs vendored
  CSS, partial trees) — currently implicit in stories.
- Migration / upgrade notes as a first-class page.
- Contributor docs (architecture, reconciler internals) separated from
  user-facing docs.
- A single canonical entry-point so the README can stay short.

---

## Option A — Minimal Markdown (GitHub-rendered)

Flat `docs/` directory of markdown files, rendered by GitHub. No site build.

```
docs/
  getting-started.md
  concepts/
    keys-and-identity.md
    reconciler.md
    theming.md
  api/
    components.md       # hand-curated; links to TSDoc
    props.md
  cookbook/
    custom-blocks.md
    partial-trees.md
    nimbus-theme.md
  migration.md
  contributing.md
```

**Audience**: beginner (`getting-started`), integrator (`concepts`, `api`,
`cookbook`), contributor (`contributing`, deep notes in `concepts/reconciler`).

**Rendering**: raw markdown on GitHub. Storybook remains the visual surface.

- **Pros**: zero tooling, trivial to maintain, works for internal + OSS,
  diff-friendly, Git blame works for prose.
- **Cons**: no search, no cross-linking sugar, component API drifts from
  hand-written docs.
- **Effort**: lowest. ~0 tooling maintenance.

## Option B — Storybook as docs surface

Co-locate MDX docs with stories; use Storybook's docs-mode as the single
reader surface. A shallow `docs/` directory carries only non-component prose.

```
src/web/
  blocks.stories.tsx
  blocks.mdx                 # concept + API for blocks
  inline.mdx
  media.mdx
  pages.mdx
  overview.mdx               # landing page in Storybook
docs/
  contributing.md
  migration.md
```

**Audience**: integrator (Storybook site), contributor (`docs/`), beginner
(Storybook overview page).

**Rendering**: Storybook dev server + static build; publish to
`storybook-static/` for preview.

- **Pros**: docs live next to components and stories; visuals and prose in
  one surface; already pay the Storybook cost.
- **Cons**: Storybook is a component-per-page model — cross-cutting topics
  (keys, reconciler) feel shoe-horned; MDX tooling churn; weaker for OSS
  discoverability than a site or plain markdown.
- **Effort**: medium. MDX + Storybook addon-docs maintenance.

## Option C — Hybrid: README gateway + `docs/` depth + Storybook for visuals

Keep README tight ("what / install / 30-line example / links"). Put depth in
`docs/`. Storybook stays the visual reference only. No site build.

```
README.md                     # gateway only; links to docs/
docs/
  getting-started.md
  concepts/
    keys-and-identity.md      # harvested from current README
    reconciler.md             # harvested from spec.md
    theming.md
  cookbook/
    custom-blocks.md
    partial-trees.md
    nimbus-vs-vendored-css.md
  api.md                      # hand-curated index pointing at TSDoc
  migration.md
  contributing.md
  internals/
    architecture.md           # harvested from vrs/spec.md
    reconciler-internals.md
```

**Audience**:
- Beginner → `README.md` + `docs/getting-started.md`
- Integrator → `docs/concepts/*`, `docs/cookbook/*`, `docs/api.md`
- Contributor → `docs/contributing.md`, `docs/internals/*`

**Rendering**: GitHub markdown for prose; Storybook for visuals (unchanged).
Optional future upgrade to Nextra/Docusaurus if OSS'd — layout already maps
1:1 to a site.

- **Pros**: low tooling, clear audience segmentation, preserves VRS as the
  source of design truth (`docs/` derives from it), easy migration path to a
  real site later, keeps README from becoming the kitchen sink.
- **Cons**: no search without a site; hand-curated API index drifts if not
  maintained (mitigated by keeping it thin and linking to TSDoc).
- **Effort**: low. Slightly higher than Option A due to audience-segmented
  folders, but no tooling cost.

## Option D — Nextra/Docusaurus site (deferred)

Standalone docs site with search, dark mode, versioned docs, MDX.

- **Pros**: best OSS shop-window; search; versioning.
- **Cons**: heavy tooling; hosting; not justified pre-OSS; can be adopted
  later without rewriting Option A or C content.
- **Effort**: high. Recommend deferring until OSS release is confirmed.

---

## Recommendation — Option C (Hybrid)

`@overeng/notion-react` sits between "small README-only library" and
"OSS site-worthy library". Option C matches that midpoint: audience-segmented
depth in `docs/` (where README is currently overflowing), a tight README as
the gateway, Storybook kept for what it's good at (visual reference), and a
1:1 structural mapping to Nextra/Docusaurus if/when the package goes public.
Zero tooling cost today, clean upgrade path tomorrow, and VRS stays the
design source of truth with `docs/` as its reader-facing projection.

## Proposed seed (on approval)

```
docs/
  README.md                 # index + reading paths per audience
  getting-started.md
  concepts/
    keys-and-identity.md
    reconciler.md
    theming.md
  cookbook/
    custom-blocks.md
    partial-trees.md
    nimbus-vs-vendored-css.md
  api.md
  migration.md
  contributing.md
  internals/
    architecture.md
    reconciler-internals.md
```

Each file stubbed with a title, one-paragraph scope, and TODO markers.
Full content authored in follow-up PRs.
