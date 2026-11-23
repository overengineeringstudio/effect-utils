# @overeng/changelog

Structured, user-facing product changelogs that ship with every build.

- **Entries are typed source files.** `.changelog/YYYY-MM-DD-slug.ts` exports `entry`. The
  filename is the identity: the id and date come from it, never from the body. Entries are decoded
  strictly (unknown keys fail).
- **Products extend the contract.** `makeChangelogContract({ product, text, fields })` chooses the
  text codec (plain strings, or `{ de, en }` for localized products) and adds product fields
  (game tags, contributors, areas).
- **The manifest belongs to a build.** `changelog.v1.json` is stamped with the build's
  `machineVersion`, read from the canonical `build-identity.json` that
  `@overeng/utils/node/vite-build-identity` emits in the same build. A waiting update therefore
  carries exactly its own changelog.
- **Coverage is enforced.** When product source paths change, the change must add an entry, or a
  commit must say `changelog: none — <reason>`.
- **Screenshots are generated, annotated and checked for freshness.** A scene (a Playwright setup
  callback) drives the app. The renderer then draws numbered rings, hand-drawn arrows, freehand
  marks and captions, and captures every configured viewport in light and dark. A content hash of
  the entry, the scene and the declared build inputs shows when images are stale.

## Entry

```ts
// .changelog/2026-11-22-wizard-trump-in-bid.ts
import type { GamesEntrySource } from '../src/platform/changelog/contract.ts'

export const entry = {
  title: { de: 'Trumpf beim Bieten', en: 'Trump while bidding' },
  summary: { de: 'Die Trumpfkarte steht jetzt direkt über deinen Geboten.', en: '…' },
  games: ['wizard'],
  screenshot: {
    alt: { de: 'Gebotsleiste mit Trumpfkarte', en: 'Bid panel with trump card' },
    crop: { target: '[data-testid="wizard-bid-panel"]', padding: 16 },
    annotations: [
      {
        kind: 'ring',
        n: 1,
        target: '[data-testid="wizard-bid-trump"]',
        caption: { de: 'Trumpf', en: 'Trump' },
      },
      { kind: 'arrow', target: '[data-testid="wizard-bid-trump"]', from: { dx: -90, dy: 60 } },
    ],
    inputs: ['src/games/wizard/**'],
  },
} satisfies GamesEntrySource
```

Entry modules contain only data and type-only imports, so the build loads them without a
bundler. Each screenshot entry has a sibling `<id>.scene.ts`:

```ts
export const scene: ChangelogScene<Browser> = async ({ browser, viewport, scheme }) => {
  const page = await newDevice(browser, viewport, 'de', 'scene')
  // … drive the app into the state worth showing
  return page
}
```

Rendered images and their records live in `.changelog/screenshots/` and are committed.

## Annotations

| kind      | draws                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ring`    | Numbered hand-drawn ring. Its caption is published in the manifest as `callouts`, so the UI renders it as localized text below the picture. |
| `arrow`   | Hand-drawn arrow ending at the target, starting from an offset to the target's centre.                                                      |
| `mark`    | Freehand `underline`, `highlight` or `scribble` on the target.                                                                              |
| `caption` | A short haloed label burnt into the image beside the target.                                                                                |

Drawing is seeded by entry id and viewport, so re-renders are byte-stable for the same page.

## Wiring

```ts
// changelog.config.ts (product)
export const changelogConfig = {
  contract, // makeChangelogContract(...)
  root: import.meta.dirname,
  sourcePaths: ['src/**'],
  screenshots: { viewports, schemes: ['light', 'dark'], themes, inputs: ['tests/helpers.ts'], renderText: (t) => t.de },
} satisfies ChangelogConfig<LocalizedText, GamesFields>

// vite.config.ts
plugins: [createBuildIdentityPlugin(...), changelogVitePlugin({ config: changelogConfig })]
```

- `@overeng/changelog/vite`: `changelogVitePlugin` emits the manifest and content-hashed
  `changelog/*.png` in builds and serves both from source in dev.
- `@overeng/changelog/node`: `checkChangelog({ config, base })` runs entry validation, the
  coverage check against `git merge-base base HEAD`, and screenshot freshness; wire it into the
  product's lint gate. `renderScreenshots({ config, browser })` (re)renders images from a
  Playwright run.
- `@overeng/changelog`: the isomorphic contract, compiler, coverage rules and annotation drawing.

Screenshots are meant to load lazily. Keep `changelog/` images out of service-worker precaches;
the manifest itself is small and belongs in the precache.
