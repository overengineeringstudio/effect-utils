/**
 * Live end-to-end proof for native `status` convergence (issue #803).
 *
 * Gated on real credentials: set `NOTION_API_TOKEN` (or `NOTION_TOKEN`) and
 * `NOTION_TEST_PARENT_PAGE_ID` (a page the integration can create databases
 * under). Without them the suite is skipped. The test creates a throwaway
 * database, exercises the apply path against it, and archives it in `afterAll`.
 *
 * Proves: preflight introspect -> apply (create missing option) ->
 * read-after-write verify -> idempotent re-apply -> fail-closed on extras ->
 * dry-run is side-effect free.
 */

import { FetchHttpClient } from '@effect/platform'
import type { HttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NotionConfig, NotionDatabases, NotionDataSources } from '@overeng/notion-effect-client'

import { applyStatusConvergence, StatusConvergeError } from './status-converge-apply.ts'

const rawToken =
  process.env.NOTION_API_TOKEN !== undefined && process.env.NOTION_API_TOKEN.length > 0
    ? process.env.NOTION_API_TOKEN
    : process.env.NOTION_TOKEN
const parentPageId = process.env.NOTION_TEST_PARENT_PAGE_ID
const isDummy = rawToken !== undefined && /dummy|fake|placeholder|test-token/i.test(rawToken)
const configured =
  rawToken !== undefined && rawToken.length > 0 && !isDummy && parentPageId !== undefined

type LiveEnv = NotionConfig | HttpClient.HttpClient

const layer: Layer.Layer<LiveEnv> =
  rawToken !== undefined
    ? Layer.merge(
        Layer.succeed(NotionConfig, { authToken: Redacted.make(rawToken) }),
        FetchHttpClient.layer,
      )
    : (Layer.empty as unknown as Layer.Layer<LiveEnv>)

const runLive = <A, E>(effect: Effect.Effect<A, E, LiveEnv>) =>
  Effect.runPromise(Effect.provide(effect, layer))

describe.skipIf(!configured)('status convergence (live e2e)', () => {
  let databaseId: string
  const property = 'Status'

  beforeAll(async () => {
    const db = await runLive(
      NotionDatabases.create({
        parent: { type: 'page_id', page_id: parentPageId! },
        title: [{ type: 'text', text: { content: 'notion-cli status-converge e2e' } }],
        properties: {
          Name: { title: {} },
          Status: {
            status: {
              options: [
                { name: 'Queued', color: 'gray' },
                { name: 'Running', color: 'yellow' },
                { name: 'Published', color: 'green' },
              ],
            },
          },
        },
      }),
    )
    databaseId = db.id
  }, 30_000)

  afterAll(async () => {
    if (databaseId !== undefined) {
      await runLive(NotionDatabases.archive({ databaseId }))
    }
  }, 30_000)

  it('creates a missing option and verifies it read-after-write', async () => {
    const result = await runLive(
      applyStatusConvergence({
        databaseId,
        property,
        desired: {
          options: ['Queued', 'Running', 'Published', 'Rolling back'],
          colors: { 'Rolling back': 'orange' },
          policy: { extras: 'ignore' },
        },
      }),
    )
    expect(result.applied).toBe(true)
    expect(result.created).toEqual(['Rolling back'])

    // Independently confirm the option is live.
    const ds = await runLive(NotionDataSources.retrieve({ dataSourceId: result.dataSourceId }))
    const names = (
      ds.properties.Status as { status: { options: { name: string }[] } }
    ).status.options.map((o) => o.name)
    expect(names).toContain('Rolling back')
    expect(names).toEqual(expect.arrayContaining(['Queued', 'Running', 'Published']))
  }, 30_000)

  it('is idempotent: re-applying the same desired set writes nothing', async () => {
    const result = await runLive(
      applyStatusConvergence({
        databaseId,
        property,
        desired: {
          options: ['Queued', 'Running', 'Published', 'Rolling back'],
          policy: { extras: 'ignore' },
        },
      }),
    )
    expect(result.applied).toBe(false)
    expect(result.created).toEqual([])
  }, 30_000)

  it('fails closed on an extra remote option (default policy) without deleting it', async () => {
    const exit = await runLive(
      Effect.either(
        applyStatusConvergence({
          databaseId,
          property,
          // Omits 'Published' and others -> they are extra-remote under fail policy.
          desired: { options: ['Queued'] },
        }),
      ),
    )
    expect(exit._tag).toBe('Left')
    if (exit._tag === 'Left') {
      expect(exit.left).toBeInstanceOf(StatusConvergeError)
      expect((exit.left as StatusConvergeError).reason).toBe('blocked')
    }

    // The "extra" options must still be present (nothing was deleted).
    const db = await runLive(NotionDatabases.retrieve({ databaseId }))
    const ds = await runLive(NotionDataSources.retrieve({ dataSourceId: db.data_sources![0]!.id }))
    const names = (
      ds.properties.Status as { status: { options: { name: string }[] } }
    ).status.options.map((o) => o.name)
    expect(names).toEqual(expect.arrayContaining(['Queued', 'Running', 'Published']))
  }, 30_000)

  it('dry-run plans a create without writing', async () => {
    const result = await runLive(
      applyStatusConvergence({
        databaseId,
        property,
        desired: {
          options: ['Queued', 'Running', 'Published', 'Rolling back', 'Archived'],
          policy: { extras: 'ignore' },
        },
        dryRun: true,
      }),
    )
    expect(result.applied).toBe(false)
    expect(result.plan.creates.map((c) => c.name)).toContain('Archived')

    // Confirm 'Archived' was NOT actually created.
    const ds = await runLive(NotionDataSources.retrieve({ dataSourceId: result.dataSourceId }))
    const names = (
      ds.properties.Status as { status: { options: { name: string }[] } }
    ).status.options.map((o) => o.name)
    expect(names).not.toContain('Archived')
  }, 30_000)
})
