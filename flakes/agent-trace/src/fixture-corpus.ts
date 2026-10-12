import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  defineArtifactRegistry,
  fingerprintInputs,
  runRegistryCli,
  type ArtifactRegistry,
} from '@schickling/schema-registry'
import { Schema } from 'effect'

import { formatArtifacts } from './generator.ts'
import { decodeLegacyFooter, decodeLegacyTrailer, upgradeLegacy } from './legacy.ts'
import * as M from './media.ts'
import { summaryText } from './render.ts'
import { ArtifactFacts, captureArtifact } from './runtime.ts'
import { AgentTraceRuntimeV1, AgentTraceV2, ModelRoute, strict } from './schema.ts'

/** Frozen structure of the committed shared TypeScript/Rust codec corpus. */
export const CodecCorpus = Schema.Struct({
  version: Schema.Literal(1),
  provenance: Schema.Struct({
    generated: Schema.Literal(true),
    regenerate: Schema.String,
    fingerprint: Schema.String,
  }),
  cases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      binding: Schema.Literals(['trailer/v2', 'footer/v4', 'trailer/v1', 'footer/v3']),
      audience: Schema.Literals(['public-minimal', 'private-rich']),
      kind: Schema.Literals(['current', 'legacy']),
      wire: Schema.String,
      view: Schema.Unknown,
      observations: Schema.optionalKey(Schema.Unknown),
      viewPath: Schema.optionalKey(Schema.String),
      wirePath: Schema.optionalKey(Schema.String),
      summary: Schema.optionalKey(Schema.String),
    }),
  ),
  runtimeCases: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      wire: Schema.String,
      runtime: Schema.Unknown,
      facts: Schema.optionalKey(ArtifactFacts),
      captured: Schema.optionalKey(Schema.Unknown),
    }),
  ),
  invalid: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      binding: Schema.Literals(['trailer/v2', 'footer/v4']),
      audience: Schema.Literals(['public-minimal', 'private-rich']),
      wire: Schema.String,
    }),
  ),
  modelRoutes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      value: Schema.String,
      utf16Length: Schema.Int,
      valid: Schema.Boolean,
    }),
  ),
  untraced: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      wire: Schema.String,
      audience: Schema.Literals(['public-minimal', 'private-rich']),
      trace: Schema.Null,
    }),
  ),
})
/** Decoded shared corpus type used by the TS consumption gate. */
export type CodecCorpus = typeof CodecCorpus.Type
const root = fileURLToPath(new URL('../', import.meta.url))
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const event = (direct: boolean): AgentTraceV2 =>
  Schema.decodeSync(
    AgentTraceV2,
    strict,
  )({
    type: 'agent-trace/v2',
    id: direct ? 'event-direct' : 'event-managed',
    at: '2026-10-10T00:00:00Z',
    artifact: 'commit:fixture',
    who: {
      agent: direct ? 'dev3.direct.omp.01a14e79' : 'agent/dotfiles/ci',
      principal: 'schickling',
      actor: 'schickling',
      persona: 'generalist',
      supervisor: 'dev3.01a14e79',
    },
    why: direct
      ? { step: { name: 'investigate' } }
      : {
          mission: { name: 'dotfiles/ci/cache-health', run: '0123456789abcdef0123456789abcdef' },
          step: { name: 'compare', run: 'fedcba9876543210fedcba9876543210' },
        },
    how: {
      harness: { tool: 'OMP', version: '18.6.0' },
      model: { route: 'anthropic/claude-opus-5-5', effort: 'medium' },
      tooling_profile: 'dotfiles@fixture-->',
      runtime_profile: 'runtime@fixture',
      skills_manifest: 'skills@fixture',
      invocation_id: direct ? 'invocation-direct' : 'invocation-managed',
      issuance: direct
        ? { _tag: 'not-st-issued', launcher: 'agent-omp' }
        : {
            _tag: 'st-issued',
            step_run: 'step-run/fedcba9876543210fedcba9876543210/compare',
          },
    },
    where: { session: 'dev3.01a14e79', host: 'dev3', worktree: 'dotfiles/fixture' },
  })
/** Rebuilds the byte-authoritative cross-language fixture corpus from the real TS codecs. */
const fixtureCorpus = (): CodecCorpus => {
  const cases: CodecCorpus['cases'][number][] = []
  const runtimeCases: CodecCorpus['runtimeCases'][number][] = []
  const runtimeCodec = Schema.fromJsonString(AgentTraceRuntimeV1)
  for (const direct of [false, true]) {
    const record = event(direct),
      actor = direct ? 'direct' : 'managed'
    const { id, at, artifact, who, why, how, where } = record
    const runtime = Schema.decodeSync(
      AgentTraceRuntimeV1,
      strict,
    )({ type: 'agent-trace-runtime/v1', who, why, how, where })
    const facts = { id, at, artifact }
    runtimeCases.push({
      id: actor + '-runtime',
      wire: Schema.encodeSync(runtimeCodec, strict)(runtime),
      runtime,
      facts,
      captured: captureArtifact({ runtime, facts }),
    })
    if (!direct) {
      const idle = Schema.decodeSync(
        AgentTraceRuntimeV1,
        strict,
      )({ type: runtime.type, who, how, where })
      runtimeCases.push({
        id: 'idle-runtime',
        wire: Schema.encodeSync(runtimeCodec, strict)(idle),
        runtime: idle,
      })
    }
    const publicTrailer = M.publicTrailerView(record),
      privateTrailer = M.privateTrailerView(record),
      publicFooter = M.publicFooterView(record),
      privateFooter = M.privateFooterView(record)
    cases.push(
      {
        id: actor + '-public-trailer',
        binding: 'trailer/v2',
        audience: 'public-minimal',
        kind: 'current',
        view: publicTrailer,
        wire: M.encodePublicTrailer(publicTrailer),
      },
      {
        id: actor + '-private-trailer',
        binding: 'trailer/v2',
        audience: 'private-rich',
        kind: 'current',
        view: privateTrailer,
        wire: M.encodePrivateTrailer(privateTrailer),
      },
      {
        id: actor + '-public-footer',
        binding: 'footer/v4',
        audience: 'public-minimal',
        kind: 'current',
        view: publicFooter,
        wire: M.encodePublicFooter(publicFooter),
      },
      {
        id: actor + '-private-footer',
        binding: 'footer/v4',
        audience: 'private-rich',
        kind: 'current',
        view: privateFooter,
        wire: M.encodePrivateFooter(privateFooter),
      },
    )
  }
  const trailer = readFileSync(root + 'fixtures/trailer-v1.txt', 'utf8'),
    footer = readFileSync(root + 'fixtures/footer-v3.txt', 'utf8')
  const legacyTrailer = decodeLegacyTrailer(trailer),
    legacyFooter = decodeLegacyFooter(footer)
  for (const audience of ['public-minimal', 'private-rich'] as const) {
    cases.push(
      {
        id: 'legacy-trailer-' + audience,
        binding: 'trailer/v1',
        audience,
        kind: 'legacy',
        wire: trailer,
        observations: legacyTrailer.fields,
        view: upgradeLegacy({ legacy: legacyTrailer, audience }),
      },
      {
        id: 'legacy-footer-' + audience,
        binding: 'footer/v3',
        audience,
        kind: 'legacy',
        wire: footer,
        observations: legacyFooter.fields,
        view: upgradeLegacy({ legacy: legacyFooter, audience }),
      },
    )
    for (const [id, wire] of [
      ['legacy-no-principal', 'agent-identity: agent/dotfiles/disk-steward-dev3\n'],
      [
        'legacy-empty-summary',
        'agent-identity: unknown\nagent-tool: unavailable\nagent-model: unknown\n',
      ],
    ] as const) {
      const legacy = decodeLegacyTrailer(wire)
      cases.push({
        id: id + '-' + audience,
        binding: 'trailer/v1',
        audience,
        kind: 'legacy',
        wire,
        observations: legacy.fields,
        view: upgradeLegacy({ legacy, audience }),
      })
    }
  }
  const current = M.publicTrailerView(event(false)),
    footerWire = M.encodePublicFooter(M.publicFooterView(event(false))),
    trailerWire = M.encodePublicTrailer(current)
  const { principal: _principal, ...withoutPrincipal } = current.who
  const machine = (value: unknown) => 'Agent-Trace: agent-trace/v2 trailer/v2 ' + json(value)
  const invalid: CodecCorpus['invalid'] = [
    {
      id: 'duplicate-machine-trailer',
      binding: 'trailer/v2',
      audience: 'public-minimal',
      wire: trailerWire + '\n' + trailerWire.split('\n').at(-1),
    },
    {
      id: 'unknown-binding-version',
      binding: 'trailer/v2',
      audience: 'public-minimal',
      wire: trailerWire.replace('trailer/v2', 'trailer/v99'),
    },
    {
      id: 'public-host-injection',
      binding: 'trailer/v2',
      audience: 'public-minimal',
      wire: machine({ ...current, who: { ...current.who, host: 'dev3' } }),
    },
    ...(['runtime_profile', 'skills_manifest', 'invocation_id'] as const).map((fact) => ({
      id: 'public-' + fact + '-injection',
      binding: 'trailer/v2' as const,
      audience: 'public-minimal' as const,
      wire: machine({ ...current, how: { ...current.how, [fact]: 'private-fact' } }),
    })),
    {
      id: 'public-issuance-injection',
      binding: 'trailer/v2',
      audience: 'public-minimal',
      wire: machine({
        ...current,
        how: { ...current.how, issuance: event(false).how.issuance },
      }),
    },
    ...[
      null,
      { _tag: 'unknown', launcher: 'agent-omp' },
      { _tag: 'st-issued' },
      { _tag: 'st-issued', step_run: 'not-a-step-run' },
      { _tag: 'not-st-issued', launcher: ' ' },
      { _tag: 'not-st-issued', launcher: 'agent-omp', step_run: 'unexpected' },
    ].map((issuance, index) => {
      const privateView = M.privateTrailerView(event(false))
      return {
        id: 'invalid-private-issuance-' + index,
        binding: 'trailer/v2' as const,
        audience: 'private-rich' as const,
        wire: machine({ ...privateView, how: { ...privateView.how, issuance } }),
      }
    }),
    {
      id: 'missing-accountable-principal',
      binding: 'trailer/v2',
      audience: 'public-minimal',
      wire: machine({ ...current, who: withoutPrincipal }),
    },
    {
      id: 'empty-purpose',
      binding: 'trailer/v2',
      audience: 'public-minimal',
      wire: machine({ ...current, why: {} }),
    },
    {
      id: 'raw-session-id',
      binding: 'footer/v4',
      audience: 'public-minimal',
      wire: footerWire.replace(
        '"session":"01a14e79"',
        '"session":"01a14e79-1234-1234-1234-0123456789ab"',
      ),
    },
    {
      id: 'host-qualified-public-session',
      binding: 'footer/v4',
      audience: 'public-minimal',
      wire: footerWire.replace('"session":"01a14e79"', '"session":"dev3.01a14e79"'),
    },
    {
      id: 'malformed-machine-json',
      binding: 'footer/v4',
      audience: 'public-minimal',
      wire: footerWire.replace(
        '<!-- agent-trace/v2 footer/v4 {',
        '<!-- agent-trace/v2 footer/v4 {invalid',
      ),
    },
  ]
  const modelRoutes = [
    { id: 'ascii-64', value: 'p/' + 'a'.repeat(62) },
    { id: 'ascii-65', value: 'p/' + 'a'.repeat(63) },
    { id: 'supplementary-utf16-64', value: 'p/' + 'a'.repeat(60) + '😀' },
    { id: 'supplementary-utf16-65', value: 'p/' + 'a'.repeat(61) + '😀' },
    { id: 'missing-provider', value: 'model' },
    { id: 'multiline-route', value: 'p/a\nb' },
  ].map(({ id, value }) => ({
    id,
    value,
    utf16Length: value.length,
    valid: Schema.is(ModelRoute)(value),
  }))
  const inputs = [
    'src/fixture-corpus.ts',
    'src/schema.ts',
    'src/runtime.ts',
    'src/bindings.ts',
    'src/projection.ts',
    'src/media.ts',
    'src/render.ts',
    'src/legacy.ts',
    'src/current-writer.ts',
    'src/generator.ts',
    'src/registry.ts',
    'fixtures/trailer-v1.txt',
    'fixtures/footer-v3.txt',
    '../../.oxfmtrc.json',
  ]
  for (const entry of cases)
    Object.assign(entry, {
      viewPath: 'codec-pairs/' + entry.id + '.view.json',
      wirePath: 'codec-pairs/' + entry.id + '.wire.txt',
      summary: summaryText(entry.view),
    })
  const untraced = (['public-minimal', 'private-rich'] as const).flatMap((audience) =>
    (
      [
        ['plain-commit', 'Update disk monitoring\n\nOrdinary human-authored changes.\n'],
        [
          'human-trailers',
          'Update disk monitoring\n\nSigned-off-by: Johannes <johannes@example.com>\nCo-authored-by: Human <human@example.com>\n',
        ],
        ['tooling-only', 'Update disk monitoring\n\ntooling-profile: dotfiles@0123456789abcdef\n'],
      ] as const
    ).map(([id, wire]) => ({ id: id + '-' + audience, wire, audience, trace: null })),
  )
  const corpus = Schema.decodeSync(
    CodecCorpus,
    strict,
  )({
    version: 1,
    provenance: {
      generated: true,
      regenerate: 'pnpm --filter @schickling/agent-trace run fixtures:generate',
      fingerprint: fingerprintInputs(
        inputs.map((path) => ({ path, content: readFileSync(root + path, 'utf8') })),
      ),
    },
    cases,
    runtimeCases,
    invalid,
    modelRoutes,
    untraced,
  })
  return corpus
}
/** Canonical batched JSON byte writer shared by pair generation and decoded-view acceptance. */
export const fixtureViewSources = (
  views: Readonly<Record<string, unknown>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(
      formatArtifacts(
        Object.fromEntries(
          Object.entries(views).map(([path, view]) => ['fixtures/' + path, json(view) + '\n']),
        ),
      ),
    ).map(([path, content]) => [path.slice('fixtures/'.length), content]),
  )

/** Emits the shared index and each positive fixture's physical JSON/text byte pair. */
export const fixtureCorpusSources = (): Record<string, string> => {
  const corpus = fixtureCorpus()
  const views: Record<string, unknown> = { 'codec-corpus.json': corpus }
  const wires: Record<string, string> = {}
  for (const entry of corpus.cases) {
    if (!entry.viewPath || !entry.wirePath)
      throw new TypeError('Shared fixture lacks its JSON/text pair paths')
    views[entry.viewPath] = entry.view
    wires[entry.wirePath] = entry.wire
  }
  return { ...fixtureViewSources(views), ...wires }
}
/** Complete shared corpus inventory consumed by the schema registry. */
export const fixtureArtifacts = (): ArtifactRegistry =>
  defineArtifactRegistry(
    Object.entries(fixtureCorpusSources()).map(([name, content]) => ({
      id: `agent-trace/fixture/${name}`,
      path: `fixtures/${name}`,
      content,
    })),
  )
if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = runRegistryCli({
    argv: process.argv.slice(2),
    repositoryRoot: root,
    get artifacts() {
      return fixtureArtifacts()
    },
    output: console.log,
  })
