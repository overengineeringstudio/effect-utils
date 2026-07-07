/**
 * notion-react demo — render this JSX tree to a live Notion page.
 *
 * On camera the presenter runs:   bun run page.tsx
 * Then edits the `phases` array below and reruns the same command; only the
 * diff is applied to Notion (see the printed op counts).
 *
 * Everything below the component is boilerplate wiring (page id + Notion auth
 * layer). The interesting, editable part is the JSX and the `phases` data.
 */
import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { NotionConfig } from '@overeng/notion-effect-client'

// notion-react resolves via relative source path (no self node_modules entry
// under the isolated pnpm linker); its transitive deps resolve from the
// package's own node_modules.
import {
  Divider,
  FsCache,
  Heading1,
  Heading2,
  Paragraph,
  sync,
  Toggle,
} from '../../../packages/@overeng/notion-react/src/mod.ts'

// ────────────────────────────────────────────────────────────────────────────
// EDIT ME — the page content.
//   • Change `budget` → the top-level intro paragraph updates in place (1 op,
//     always visible on screen).
//   • Add / remove / reorder a `phases` entry → one op each (a new toggle
//     header is visible even while collapsed).
// ────────────────────────────────────────────────────────────────────────────

type Phase = { readonly id: string; readonly title: string; readonly body: string }

const budget = '$4.2M'
const milestones = 7

const phases: readonly Phase[] = [
  { id: 'p1', title: 'Phase 1 — Manufacturing', body: 'first batch in production' },
  { id: 'p2', title: 'Phase 2 — Marketing', body: 'campaign kickoff' },
  { id: 'p3', title: 'Phase 3 — Retail rollout', body: 'flagship stores live' },
]

const LaunchPlan = () => (
  <>
    <Heading1>Q2 Launch Plan</Heading1>
    <Paragraph>{`Budget ${budget} · ${milestones} milestones · generated from JSX`}</Paragraph>
    <Divider />
    <Heading2>Phases</Heading2>
    {phases.map((p) => (
      <Toggle key={p.id} blockKey={p.id} title={p.title}>
        <Paragraph>{p.body}</Paragraph>
      </Toggle>
    ))}
  </>
)

// ────────────────────────────────────────────────────────────────────────────
// Wiring (not the interesting part). Reads the target page id from the demo-env
// export ($DEMO_REACT_PAGE_ID, set by `eval "$(demo/env/demo-env new --export)"`)
// and keeps a persisted FsCache next to this file so reruns diff against the last
// sync. This file runs from $DEMO_REACT_DIR (a fresh copy per env).
// ────────────────────────────────────────────────────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url))
const pageId = process.env.DEMO_REACT_PAGE_ID?.trim()
if (!pageId) {
  throw new Error(
    'DEMO_REACT_PAGE_ID is not set — run: eval "$(demo/env/demo-env new --export)" (inside devenv shell)',
  )
}
const cache = FsCache.make(path.join(here, 'notion-cache.json'))

const layer = Layer.mergeAll(
  Layer.succeed(NotionConfig, {
    authToken: Redacted.make(process.env.NOTION_API_TOKEN ?? ''),
    retryEnabled: true,
    maxRetries: 5,
    retryBaseDelay: 1000,
  }),
  FetchHttpClient.layer,
)

const res = await Effect.runPromise(sync(<LaunchPlan />, { pageId, cache }).pipe(Effect.provide(layer)))

const { appends, updates, inserts, removes, fallbackReason } = res
// eslint-disable-next-line no-console
console.log(
  `synced → appends:${appends} updates:${updates} inserts:${inserts} removes:${removes}` +
    (fallbackReason ? ` (${fallbackReason})` : ''),
)
