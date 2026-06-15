/**
 * OTEL instrumentation contract test for `mr store gc` (decision 0007).
 *
 * The principled replacement for "disable OTEL in tests": instead of asserting
 * nothing about telemetry, this stands up a REAL ephemeral OTLP receiver
 * (`Otelite.capture`), points the gc's REAL exporter (`makeOtelCliLayer` →
 * `Otlp.layerJson`, both traces AND metrics) at it within the test scope, runs
 * the gc in-process through the same deterministic harness the cold test uses
 * (fixed decision clock + stub `PrStateResolver`, no real `gh`/network), and
 * asserts the spans + the RSS gauge actually land in Tempo-shaped capture.
 *
 * It is hermetic by construction (its own ephemeral receiver, unset on scope
 * close) and non-vacuous (it fails loudly if the phase spans, the `git/cmd`
 * span's `git.output.bytes`, or the `megarepo_store_gc_rss_bytes` gauge are
 * absent). Because it sets the endpoint itself under the fixed clock, it ALSO
 * proves the sampler + exporter no longer hang under a zero-sleep clock (with
 * the old, clock-coupled sampler/exporter this run would time out).
 */

import * as Cli from '@effect/cli'
import { Command, FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Clock, Effect, Exit, Layer, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath, type RelativeDirPath } from '@overeng/effect-path'
import { Otelite } from '@overeng/utils-dev/otelite'
import { makeOtelCliLayer } from '@overeng/utils/node/otel'

import { makeStubPrStateResolverLayer, type GhPr, type StubPrRepo } from '../lib/store-pr-state.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { createStoreFixture, getWorktreeCommit } from '../test-utils/store-setup.ts'
import { Cwd } from './context.ts'
import { mrCommand } from './mod.ts'

const DAY_MS = 24 * 60 * 60 * 1000
/** A fixed decision clock: well past every default grace window. */
const NOW = Date.parse('2026-06-11T12:00:00.000Z')

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const command = Command.make('git', ...args).pipe(Command.workingDirectory(cwd))
    return (yield* Command.string(command)).trim()
  })

/**
 * Deterministic DECISION clock — `currentTime{Millis,Nanos}` are pinned to
 * `nowMs` so every grace/retention decision is reproducible — but `sleep`
 * delegates to a REAL live clock (`Clock.make()`) instead of the cold test's
 * `() => Effect.void`.
 *
 * Why real sleep here: this test runs the gc with the OTEL exporter active, and
 * both the forked RSS sampler and `Otlp.layerJson`'s reader fibers schedule on
 * `Clock.sleep`. A zero-sleep clock turns those infra timers into hot loops that
 * starve the runtime and hang the run. A real `sleep` (decision time still fixed)
 * lets the infra timers tick on wall time while keeping gc decisions deterministic
 * — the root-cause fix, with no production workaround in `makeOtelCliLayer`.
 */
const liveClock = Clock.make()
const fixedClockLayer = (nowMs: number) =>
  Layer.setClock({
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    currentTimeMillis: Effect.succeed(nowMs),
    currentTimeNanos: Effect.succeed(BigInt(nowMs) * 1_000_000n),
    sleep: (duration) => liveClock.sleep(duration),
    unsafeCurrentTimeMillis: () => nowMs,
    unsafeCurrentTimeNanos: () => BigInt(nowMs) * 1_000_000n,
  })

const REPO = { host: 'github.com', owner: 'acme', repo: 'widget' } as const
const REPO_KEY = `${REPO.host}/${REPO.owner}/${REPO.repo}`
const REPO_RELATIVE = `${REPO_KEY}/` as RelativeDirPath

const mergedPr = (branch: string, mergedAt: number): GhPr => ({
  number: 1,
  state: 'MERGED',
  headRefName: branch,
  mergedAt: new Date(mergedAt).toISOString(),
  closedAt: new Date(mergedAt).toISOString(),
})

const StoreGcJsonOutput = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      repo: Schema.String,
      ref: Schema.String,
      status: Schema.String,
      reason: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
})
const decodeGc = Schema.decodeUnknownSync(Schema.parseJson(StoreGcJsonOutput))

/**
 * Run `mr store gc` end-to-end with the REAL OTEL exporter pointed at the given
 * base endpoint. Mirrors the cold-path harness (fixed clock + stub resolver),
 * but additionally provides `makeOtelCliLayer` so the gc's spans/metrics are
 * actually exported. The endpoint is passed EXPLICITLY into the layer (no
 * `process.env` mutation): the layer stays a pure function of its input, and the
 * `OtelConfig` it provides is what the gc's RSS-sampler gate reads. A small
 * `metricsExportInterval` + generous `shutdownTimeout` guarantee ≥1 metrics
 * collection (or the shutdown flush) lands the gauge for a sub-interval run.
 */
const runGcExported = ({
  cwd,
  storePath,
  prRepos,
  endpoint,
  now = NOW,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  prRepos: ReadonlyArray<StubPrRepo>
  endpoint: string
  now?: number
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    const previous = process.env['MEGAREPO_STORE']
    process.env['MEGAREPO_STORE'] = storePath

    const otelLayer = makeOtelCliLayer({
      serviceName: 'megarepo',
      endpoint: Option.some(endpoint),
      exportInterval: 50,
      metricsExportInterval: 250,
      shutdownTimeout: 4000,
    })

    const argv = ['node', 'mr', 'store', 'gc', '--output', 'json']
    const exit = yield* Cli.Command.run(mrCommand, { name: 'mr', version: 'test' })(argv).pipe(
      Effect.provideService(Cwd, cwd),
      Effect.provide(consoleLayer),
      Effect.provide(makeStubPrStateResolverLayer(prRepos)),
      Effect.provide(otelLayer),
      Effect.provide(fixedClockLayer(now)),
      Effect.scoped,
      Effect.exit,
    )

    if (previous === undefined) delete process.env['MEGAREPO_STORE']
    else process.env['MEGAREPO_STORE'] = previous

    const stdout = (yield* getStdoutLines).join('\n')
    return { exitCode: Exit.isSuccess(exit) === true ? 0 : 1, results: decodeGc(stdout).results }
  })

/** Seed the observation ledger so absence grace is satisfied at NOW. Runs an
 *  earlier exported gc with no PR evidence (recording `firstSeenColdAtMs`). */
const seedColdObservation = ({
  cwd,
  storePath,
  endpoint,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  endpoint: string
}) =>
  runGcExported({
    cwd,
    storePath,
    endpoint,
    prRepos: [{ relativePath: REPO_RELATIVE, prs: [] }],
    now: NOW - 20 * DAY_MS,
  })

const outsideCwd = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tmpDir = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    const cwd = EffectPath.ops.join(tmpDir, EffectPath.unsafe.relativeDir('outside/'))
    yield* fs.makeDirectory(cwd, { recursive: true })
    return cwd
  })

/** Open a scoped ephemeral otelite receiver. Its base URL (Otlp.layerJson appends
 *  `/v1/traces` + `/v1/metrics` itself) is passed EXPLICITLY into the gc's
 *  `makeOtelCliLayer` by the caller — no `process.env` mutation, so the exporter
 *  is wired purely from the resolved endpoint. */
const withCapture = Effect.gen(function* () {
  const otelite = yield* Otelite
  return yield* otelite.capture({})
})

const EXPECTED_PHASES = [
  'collect-liveness',
  'list-repos',
  'collect-worktrees',
  'resolve-pr',
  'cold-reclaim',
  'legacy-sweep',
] as const

describe('mr store gc — OTEL instrumentation contract', () => {
  it.scoped(
    'exports the gc phase spans, a git/cmd span with git.output.bytes, and the RSS gauge',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { storePath, bareRepoPaths, worktreePaths } = yield* createStoreFixture([
          { ...REPO, branches: ['feature/merged'], withRemote: true },
        ])
        const bareRepoPath = bareRepoPaths[REPO_KEY]!
        const worktreePath = worktreePaths[`${REPO_KEY}#feature/merged`]!
        const commit = yield* getWorktreeCommit(worktreePath)
        // Materialize the branch ref so the cold/merged path classifies it.
        yield* git(bareRepoPath, 'branch', 'feature/merged', commit)

        const cwd = yield* outsideCwd()

        // Stand up the ephemeral receiver + point the gc exporter at it for the
        // whole run. Telemetry being active must NOT change gc decisions, so the
        // seed below runs under the exporter exactly as a real gc would.
        const cap = yield* withCapture

        // Seed cold (absence grace) so the asserted run takes the cold-reclaim
        // path. The fixed DECISION clock keeps this reproducible; the real `sleep`
        // lets the exporter/sampler infra timers tick without busy-spinning.
        yield* seedColdObservation({ cwd, storePath, endpoint: cap.endpoints.http })

        const { results } = yield* runGcExported({
          cwd,
          storePath,
          endpoint: cap.endpoints.http,
          prRepos: [
            { relativePath: REPO_RELATIVE, prs: [mergedPr('feature/merged', NOW - 30 * DAY_MS)] },
          ],
        })

        // The gc actually did its work (sanity: the cold-reclaim path ran).
        expect(results.some((r) => r.ref === 'feature/merged' && r.status === 'archived')).toBe(
          true,
        )
        // The worktree was archived away (cold-reclaim executed, not a no-op).
        expect(yield* fs.exists(worktreePath)).toBe(false)

        // --- Assert the phase spans landed in Tempo-shaped capture. ---
        const capturedPhases = new Set<string>()
        for (const phase of EXPECTED_PHASES) {
          const spans = yield* cap.inspect({
            signal: 'traces',
            name: `megarepo/store/gc/${phase}`,
          })
          if (spans.length > 0) capturedPhases.add(phase)
        }
        // All six phases of the default cold path must have emitted ≥1 span.
        expect([...capturedPhases].sort()).toEqual([...EXPECTED_PHASES].sort())

        // --- Assert a git/cmd span carries the scalar git.output.bytes attr. ---
        const gitSpans = yield* cap.inspect({ signal: 'traces', name: 'git/cmd' })
        expect(gitSpans.length).toBeGreaterThan(0)
        expect(gitSpans.some((s) => 'git.output.bytes' in s.attrs)).toBe(true)

        // --- Assert the RSS gauge landed with value>0 and a repo_concurrency label. ---
        const rss = yield* cap.inspect({
          signal: 'metrics',
          name: 'megarepo_store_gc_rss_bytes',
        })
        expect(rss.length).toBeGreaterThan(0)
        const withValue = rss.find((row) => (row.value ?? 0) > 0)
        expect(withValue).toBeDefined()
        expect(withValue!.attrs['repo_concurrency']).toBeDefined()
      }).pipe(Effect.provide(Otelite.Default), Effect.provide(NodeContext.layer)),
    60_000,
  )
})
