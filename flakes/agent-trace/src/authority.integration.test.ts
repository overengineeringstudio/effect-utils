import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

import { checkArtifacts } from '@schickling/schema-registry'
import { Arbitrary, Effect, Schema } from 'effect'
import { describe, it, expect } from 'vitest'

import { footerV4, trailerV2, validateBinding } from './bindings.ts'
import { generatedArtifacts } from './generator.ts'
import { decodeLegacyFooter, decodeLegacyTrailer, upgradeLegacy } from './legacy.ts'
import * as M from './media.ts'
import { object } from './projection.ts'
import { AgentTraceV2, auditAnnotations, ModelRoute, SessionLookup, strict } from './schema.ts'
const fixture = Schema.decodeSync(
  AgentTraceV2,
  strict,
)({
  type: 'agent-trace/v2',
  id: 'event-1',
  at: '2026-10-10T00:00:00Z',
  artifact: 'commit:123',
  who: { agent: 'agent/dotfiles/ci', principal: 'schickling', supervisor: 'dev3.01a14e79' },
  why: {
    mission: { name: 'dotfiles/ci/cache-health', run: '0123456789abcdef0123456789abcdef' },
    step: { name: 'compare' },
  },
  how: {
    harness: { tool: 'OMP', version: '18.6.0' },
    model: { route: 'anthropic/claude-opus-5-5', effort: 'medium' },
    tooling_profile: 'dotfiles@abc',
    runtime_profile: 'runtime@fixture',
    skills_manifest: 'skills@fixture',
    invocation_id: 'invocation-fixture',
    issuance: {
      _tag: 'st-issued',
      step_run: 'step-run/fedcba9876543210fedcba9876543210/compare',
    },
  },
  where: { session: 'dev3.01a14e79', host: 'dev3', worktree: 'dotfiles/branch' },
})
describe('Agent Trace authority', () => {
  it.each([
    {
      name: 'trailer/v2 public-minimal',
      law: (record: AgentTraceV2) => {
        const view = M.publicTrailerView(record)
        return isDeepStrictEqual(M.decodePublicTrailer(M.encodePublicTrailer(view)), view)
      },
    },
    {
      name: 'trailer/v2 private-rich',
      law: (record: AgentTraceV2) => {
        const view = M.privateTrailerView(record)
        return isDeepStrictEqual(M.decodePrivateTrailer(M.encodePrivateTrailer(view)), view)
      },
    },
    {
      name: 'footer/v4 public-minimal',
      law: (record: AgentTraceV2) => {
        const view = M.publicFooterView(record)
        return isDeepStrictEqual(M.decodePublicFooter(M.encodePublicFooter(view)), view)
      },
    },
    {
      name: 'footer/v4 private-rich',
      law: (record: AgentTraceV2) => {
        const view = M.privateFooterView(record)
        return isDeepStrictEqual(M.decodePrivateFooter(M.encodePrivateFooter(view)), view)
      },
    },
  ])('round-trips $name over 1000 semantic records', async ({ law }) => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(Arbitrary.schema(AgentTraceV2), law, {
        runs: 1000,
        seed: 18473,
        maxDiscards: 200000,
      }),
    )
    expect(result).toMatchObject({ _tag: 'Passed', runs: 1000 })
  })
  it('audits every node and rejects a deliberately incomplete fixture', () => {
    auditAnnotations(AgentTraceV2.ast)
    const incomplete = Schema.Struct({ missing: Schema.String }).pipe(
      Schema.annotateKey({
        title: 'Fixture',
        description: 'Incomplete annotation fixture',
        'x-sensitivity': 'public',
      }),
    )
    expect(() => auditAnnotations(incomplete.ast)).toThrow(
      'lacks title, description or sensitivity',
    )
    for (const schema of [
      Schema.Array(Schema.String),
      Schema.Union([Schema.String, Schema.Finite]),
    ]) {
      const incompleteComposite = schema.pipe(
        Schema.annotateKey({
          title: 'Composite fixture',
          description: 'Container metadata must not mask missing child annotations',
          'x-sensitivity': 'public',
        }),
      )
      expect(() => auditAnnotations(incompleteComposite.ast)).toThrow(
        'lacks title, description or sensitivity',
      )
    }
    validateBinding(footerV4)
    validateBinding(trailerV2)
    expect(() => validateBinding({ ...trailerV2, paths: {} })).toThrow('every leaf')
  })
  it('requires complete current writers while legacy upgrades stay sparse', () => {
    const cases = [
      { codec: M.PublicTrailerCodecV2, view: M.publicTrailerView(fixture) },
      { codec: M.PrivateTrailerCodecV2, view: M.privateTrailerView(fixture) },
      { codec: M.PublicFooterCodecV4, view: M.publicFooterView(fixture) },
      { codec: M.PrivateFooterCodecV4, view: M.privateFooterView(fixture) },
    ]
    for (const { codec, view } of cases) {
      const encode = Schema.encodeUnknownSync(codec, strict)
      const { agent: _agent, ...withoutAgent } = view.who
      const { principal: _principal, ...withoutPrincipal } = view.who
      const { harness: _harness, ...withoutHarness } = view.how
      const { model: _model, ...withoutModel } = view.how
      expect(() => encode({ ...view, who: withoutAgent })).toThrow('Current writer requires')
      expect(() => encode({ ...view, who: withoutPrincipal })).toThrow('Current writer requires')
      expect(() => encode({ ...view, how: withoutHarness })).toThrow('Current writer requires')
      expect(() => encode({ ...view, how: withoutModel })).toThrow('Current writer requires')
      expect(() => encode({ ...view, why: {} })).toThrow('Current writer requires why')
    }
    const sparse = upgradeLegacy({
      legacy: decodeLegacyTrailer(
        'agent-tool: OMP\nagent-model: unavailable\nagent-identity: unknown',
      ),
      audience: 'public-minimal',
    })
    expect(Object.hasOwn(sparse.who, 'principal')).toBe(false)
    expect(Object.hasOwn(sparse.how, 'model')).toBe(false)
    expect(() => Schema.encodeUnknownSync(M.PublicTrailerCodecV2, strict)(sparse)).toThrow(
      'Current writer requires',
    )
    const sparseMachine = Schema.encodeUnknownSync(
      Schema.fromJsonString(M.PublicTrailerV2),
      strict,
    )(sparse)
    expect(() =>
      M.decodePublicTrailer('Agent-Trace: agent-trace/v2 trailer/v2 ' + sparseMachine),
    ).toThrow('Current writer requires')
    expect(() => M.publicTrailerView({ ...fixture, why: {} })).toThrow()
    for (const project of [
      M.publicTrailerView,
      M.privateTrailerView,
      M.publicFooterView,
      M.privateFooterView,
    ]) {
      // The omitted envelope still validates on every call through a reused projection.
      expect(() => project({ ...fixture, id: '' })).toThrow()
      expect(() => project(fixture)).not.toThrow()
    }
  })
  it('enforces publication and raw-session boundaries at runtime', () => {
    const view = M.publicFooterView(fixture),
      wire = M.encodePublicFooter(view)
    expect(wire.includes('dev3')).toBe(false)
    expect(wire.includes('tooling_profile')).toBe(false)
    expect(wire.includes('"effort"')).toBe(false)
    expect(view.where.session).toBe('01a14e79')
    expect(() => Schema.decodeSync(SessionLookup)('01a14e79-1234-1234-1234-0123456789ab')).toThrow()
    expect(() => Schema.decodeSync(ModelRoute)('provider/' + 'x'.repeat(60))).toThrow()
    const injected = { ...view, where: { ...view.where, host: 'dev3' } }
    expect(() => M.encodePublicFooter(injected)).toThrow()
  })
  it('preserves internal runtime facts privately and omits them from every public projection', () => {
    const facts = {
      runtime_profile: fixture.how.runtime_profile,
      skills_manifest: fixture.how.skills_manifest,
      invocation_id: fixture.how.invocation_id,
      issuance: fixture.how.issuance,
    }
    const privateAudience = object(M.projectPrivate(fixture))
    expect(privateAudience.how).toMatchObject(facts)
    const publicAudience = object(M.projectPublic(fixture))
    for (const key of Object.keys(facts))
      expect(Object.hasOwn(object(publicAudience.how), key)).toBe(false)
    for (const project of [M.privateTrailerView, M.privateFooterView]) {
      const view = project(fixture)
      expect(view.how).toMatchObject(facts)
    }
    expect(
      M.decodePrivateTrailer(M.encodePrivateTrailer(M.privateTrailerView(fixture))).how,
    ).toMatchObject(facts)
    expect(
      M.decodePrivateFooter(M.encodePrivateFooter(M.privateFooterView(fixture))).how,
    ).toMatchObject(facts)
    for (const [project, codec] of [
      [M.publicTrailerView, M.PublicTrailerCodecV2],
      [M.publicFooterView, M.PublicFooterCodecV4],
    ] as const) {
      const view = project(fixture)
      for (const key of Object.keys(facts)) {
        expect(Object.hasOwn(view.how, key)).toBe(false)
        expect(() =>
          Schema.encodeUnknownSync(
            codec,
            strict,
          )({
            ...view,
            how: { ...view.how, [key]: 'private-fact' },
          }),
        ).toThrow()
      }
    }
  })
  it('checks machine-authoritative rendering drift and safe HTML comments', () => {
    const view = M.privateFooterView({ ...fixture, who: { ...fixture.who, persona: 'x-->' } })
    const wire = M.encodePrivateFooter(view)
    expect(M.decodePrivateFooter(wire)).toEqual(view)
    expect(wire).toContain('\\u002d\\u002d\\u003e')
    expect(M.hasRenderingDrift({ wire: wire, audience: 'private-rich', medium: 'footer' })).toBe(
      false,
    )
    expect(
      M.hasRenderingDrift({
        wire: wire.replace('Posted on behalf of', 'Tampered'),
        audience: 'private-rich',
        medium: 'footer',
      }),
    ).toBe(true)
    const trailer = M.encodePublicTrailer(M.publicTrailerView(fixture))
    expect(
      M.hasRenderingDrift({ wire: trailer, audience: 'public-minimal', medium: 'trailer' }),
    ).toBe(false)
  })
  it('decodes the last 600 origin/main commit bodies with zero failures', () => {
    const output = execFileSync('git', ['log', '-600', 'origin/main', '--format=%B%x00'], {
      cwd: new URL('../../../', import.meta.url),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    })
    const bodies = output.split('\0').filter((body) => body.trim())
    expect(bodies).toHaveLength(600)
    for (const body of bodies) {
      const legacy = decodeLegacyTrailer(body)
      upgradeLegacy({ legacy: legacy, audience: 'public-minimal' })
      upgradeLegacy({ legacy: legacy, audience: 'private-rich' })
    }
  })
  it('upgrades the captured production footer without fabricating an event', () => {
    const legacy = decodeLegacyFooter(
      readFileSync(new URL('../fixtures/footer-v3.txt', import.meta.url), 'utf8'),
    )
    expect(legacy.fields['agent-supervisor']).toEqual({ _tag: 'unavailable' })
    const upgraded = upgradeLegacy({ legacy: legacy, audience: 'public-minimal' })
    expect(Object.hasOwn(upgraded, 'id')).toBe(false)
    expect(Object.hasOwn(upgraded, 'at')).toBe(false)
    expect(Object.hasOwn(upgraded, 'artifact')).toBe(false)
    upgradeLegacy({ legacy: legacy, audience: 'private-rich' })
  })
  it.each([
    { entrypoint: 'generator.ts', artifact: 'generated/AgentTraceV2.schema.json' },
    { entrypoint: 'fixture-corpus.ts', artifact: 'fixtures/codec-corpus.json' },
  ])(
    'rejects misspelled $entrypoint commands without artifact writes',
    ({ entrypoint, artifact }) => {
      const path = new URL('../' + artifact, import.meta.url)
      const before = { bytes: readFileSync(path), mtime: statSync(path).mtimeMs }
      expect(() =>
        execFileSync('bun', [fileURLToPath(new URL(entrypoint, import.meta.url)), 'genrate'], {
          encoding: 'utf8',
        }),
      ).toThrow('Usage: schema-registry generate|check|diff')
      expect(readFileSync(path)).toEqual(before.bytes)
      expect(statSync(path).mtimeMs).toBe(before.mtime)
    },
  )
  it('has byte-exact generated artifacts', () =>
    checkArtifacts({
      repositoryRoot: fileURLToPath(new URL('../', import.meta.url)),
      artifacts: generatedArtifacts(),
    }))
})
