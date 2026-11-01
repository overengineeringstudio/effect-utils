import { describe, expect, it } from 'bun:test'

import { classifyCacheAction, decodeActionArtifact } from './buck2-action-evidence-codec.ts'
import {
  darwinUnsandboxedCategories,
  localMaterializationCategories,
} from './buck2-action-evidence.ts'
import {
  actionFixture,
  artifactFixture,
  encodedFixture,
  loadedFixture,
  manifestFixture,
} from './buck2-cache-warm99.fixtures.ts'
import {
  decodeEvidence,
  decodeManifest,
  evaluateWarm99,
  renderWarm99Diagnostics,
} from './buck2-cache-warm99.ts'

const rawArtifact = (artifact = artifactFixture()): string =>
  `${[artifact.header, ...artifact.actions].map((item) => JSON.stringify(item)).join('\n')}\n`
describe('strict action boundary', () => {
  it('decodes explicit policy and retained context without inferring native outcomes', () => {
    for (const context of [
      'capability-identity-dependency',
      'capability-identity-baseline',
      'native-log',
      null,
    ]) {
      const artifact = artifactFixture()
      artifact.header.invocations[0]!.context = context
      const raw = rawArtifact(artifact)
      expect(decodeActionArtifact(raw).header.invocations[0]!.cacheReadPolicy).toBe('enabled')
      const retained = raw.replaceAll('"cacheReadPolicy":"enabled",', '')
      expect(decodeActionArtifact(retained).header.invocations[0]!.cacheReadPolicy).toBe(
        context === 'capability-identity-dependency' ? 'disabled-by-design' : 'unknown',
      )
    }
    expect(() => decodeActionArtifact(rawArtifact().replace('"enabled"', '"invalid"'))).toThrow()
  })
  it('classifies disabled local executions without hiding native local hits', () => {
    const invocation = artifactFixture().header.invocations[0]!
    for (const cacheReadPolicy of ['enabled', 'disabled-by-design', 'unknown'] as const) {
      for (const executionKind of [1, 8, 10]) {
        expect(
          classifyCacheAction({
            action: actionFixture({ buildId: invocation.buildId, executionKind }),
            invocation: { ...invocation, cacheReadPolicy },
          }),
        ).toBe(
          executionKind === 10
            ? 'local-action-cache-hit'
            : cacheReadPolicy === 'disabled-by-design'
              ? 'other'
              : 'fresh-local-execution',
        )
      }
    }
  })
  it('classifies kind-10 reuse as hits and only fresh kind-1/8 digest executions as candidates', () => {
    const invocation = artifactFixture().header.invocations[0]!
    for (const executionKind of [1, 8, 10]) {
      for (const freshRoot of [false, true]) {
        for (const digest of [null, 'a'.repeat(64) + ':123']) {
          const action = actionFixture({ buildId: invocation.buildId, executionKind, digest })
          expect(
            classifyCacheAction({ action: action, invocation: { ...invocation, freshRoot } }),
          ).toBe(
            executionKind === 10
              ? 'local-action-cache-hit'
              : freshRoot === true && digest !== null
                ? 'fresh-local-execution'
                : 'other',
          )
        }
      }
    }
    expect(
      classifyCacheAction({ action: actionFixture({ executionKind: 1 }), invocation: undefined }),
    ).toBe('other')
  })
  it('excludes policy executions from R08 candidates but preserves native local-action-cache hits', () => {
    const invocation = artifactFixture().header.invocations[0]!
    for (const category of localMaterializationCategories) {
      for (const executionKind of [1, 8, 10]) {
        const action = actionFixture({
          category,
          buildId: invocation.buildId,
          executionKind,
          digest: executionKind === 10 ? null : 'abcd:12',
        })
        expect(action.exclusionReason).toBe('local-materialization-policy')
        expect(classifyCacheAction({ action: action, invocation: invocation })).toBe(
          executionKind === 10 ? 'local-action-cache-hit' : 'other',
        )
      }
    }
    for (const executionKind of [1, 8]) {
      expect(
        classifyCacheAction({
          action: actionFixture({
            category: 'tsgo_emit',
            executionKind,
            buildId: invocation.buildId,
          }),
          invocation: invocation,
        }),
      ).toBe('fresh-local-execution')
    }
  })

  it('roundtrips named policy exclusions and derives them from historical remote-hit rows', () => {
    const artifact = artifactFixture(false, [
      ...localMaterializationCategories.map((category) => actionFixture({ category })),
      actionFixture({ category: 'tsgo_emit' }),
    ])
    const encoded = encodedFixture(artifact)
    expect(
      decodeEvidence({
        compressed: encoded.compressed,
        summary: encoded.summary,
        expectedLane: 'main-reader',
      }),
    ).toEqual(artifact)
    const { excludedByDesign: _root, ...header } = artifact.header
    const historical = {
      ...header,
      invocations: header.invocations.map(
        ({ excludedByDesign: _counts, ...invocation }) => invocation,
      ),
    }
    const rows = artifact.actions.map(({ exclusionReason: _reason, ...action }) => action)
    const decoded = decodeActionArtifact(
      `${[historical, ...rows].map((row) => JSON.stringify(row)).join('\n')}\n`,
    )
    expect(decoded).toEqual(artifact)
    expect(decoded.header.excludedByDesign).toEqual({
      'local-materialization-policy': localMaterializationCategories.length,
      'darwin-unsandboxed': 0,
    })
    expect(decoded.actions.map((action) => action.outcome)).toEqual(
      Array(localMaterializationCategories.length + 1).fill('remote-hit'),
    )
    expect(() =>
      decodeEvidence({
        compressed: encoded.compressed,
        summary: {
          ...encoded.summary,
          excludedByDesign: { 'local-materialization-policy': 0, 'darwin-unsandboxed': 0 },
        },
        expectedLane: 'main-reader',
      }),
    ).toThrow()
    expect(() =>
      decodeEvidence({
        compressed: encoded.compressed,
        summary: {
          ...encoded.summary,
          invocations: encoded.summary.invocations.map((invocation) =>
            Object.assign({}, invocation, {
              excludedByDesign: {
                'local-materialization-policy': 0,
                'darwin-unsandboxed': 0,
              },
            }),
          ),
        },
        expectedLane: 'main-reader',
      }),
    ).toThrow()
    expect(() =>
      decodeActionArtifact(
        encoded.raw.replace(
          '"exclusionReason":"local-materialization-policy"',
          '"exclusionReason":null',
        ),
      ),
    ).toThrow()
  })

  it('excludes Darwin TS execution and validates its named full-artifact counters', () => {
    const artifact = artifactFixture(
      false,
      darwinUnsandboxedCategories.map((category) =>
        actionFixture({ category, executionKind: 1, cacheUploadResult: 0 }),
      ),
    )
    const encoded = encodedFixture(artifact)
    expect(
      decodeEvidence({
        compressed: encoded.compressed,
        summary: encoded.summary,
        expectedLane: 'main-reader',
      }),
    ).toEqual(artifact)
    expect(artifact.header.excludedByDesign).toEqual({
      'local-materialization-policy': 0,
      'darwin-unsandboxed': darwinUnsandboxedCategories.length,
    })
    for (const action of artifact.actions) {
      expect(action.exclusionReason).toBe('darwin-unsandboxed')
      expect(
        classifyCacheAction({ action: action, invocation: artifact.header.invocations[0] }),
      ).toBe('other')
    }
    expect(() =>
      decodeEvidence({
        compressed: encoded.compressed,
        summary: {
          ...encoded.summary,
          excludedByDesign: { 'local-materialization-policy': 0, 'darwin-unsandboxed': 0 },
        },
        expectedLane: 'main-reader',
      }),
    ).toThrow()
    expect(() =>
      decodeActionArtifact(
        encoded.raw.replace('"exclusionReason":"darwin-unsandboxed"', '"exclusionReason":null'),
      ),
    ).toThrow()
  })

  it('preserves unsupported raw enums only in explicitly incomplete artifacts', () => {
    const artifact = artifactFixture(false, [
      actionFixture({ executionKind: 99, cacheUploadResult: 99 }),
    ])
    artifact.header.complete = false
    artifact.header.evidenceGaps = ['unsupported-native-enum']
    const decoded = decodeActionArtifact(rawArtifact(artifact))
    expect(decoded.actions[0]?.executionKind).toBe(99)
    expect(decoded.actions[0]?.cacheUploadResult).toBe(99)
    expect(decoded.header.complete).toBe(false)
  })
  it('retains null identities and legitimate noncommand digest omissions', () => {
    const artifact = artifactFixture(false, [actionFixture({ commandAction: false, digest: null })])
    expect(decodeActionArtifact(rawArtifact(artifact)).actions[0]?.digest).toBeNull()
  })
  it('rejects unsupported schemas/enums, missing fields and truncated rows', () => {
    const raw = rawArtifact()
    for (const bad of [
      raw.replace('"schemaVersion":1', '"schemaVersion":2'),
      raw.replace('"executionKind":3', '"executionKind":99'),
      raw.replace('"cacheUploadResult":0', '"cacheUploadResult":17'),
      raw.replace('"configuration":"linux#1",', ''),
      raw.slice(0, -1),
      raw.replace('"lane":"main-reader"', '"lane":"unknown"'),
    ]) {
      expect(() => decodeActionArtifact(bad)).toThrow()
    }
  })
  it('retains explicit incomplete count mismatches but rejects purported complete ones', () => {
    const artifact = artifactFixture()
    artifact.header.actionCount++
    expect(() => decodeActionArtifact(rawArtifact(artifact))).toThrow()
    artifact.header.complete = false
    expect(decodeActionArtifact(rawArtifact(artifact)).header.complete).toBe(false)
  })
  it('rejects complete invocations outside the job window while accepting equality', () => {
    const artifact = artifactFixture()
    expect(decodeActionArtifact(rawArtifact(artifact)).header.complete).toBe(true)
    artifact.header.metadata.startedAt = 201
    expect(() => decodeActionArtifact(rawArtifact(artifact))).toThrow()
    artifact.header.metadata.startedAt = 200
    artifact.header.metadata.finishedAt = 299
    expect(() => decodeActionArtifact(rawArtifact(artifact))).toThrow()
    artifact.header.complete = false
    expect(decodeActionArtifact(rawArtifact(artifact)).header.complete).toBe(false)
  })
})
describe('warm99 identity acceptance', () => {
  it('prints every lane and observation without reader IDs or native identities', () => {
    const manifest = manifestFixture(['main-reader', 'merge_group', 'pr'])
    const report = evaluateWarm99({ manifest, loaded: loadedFixture(manifest) })
    for (const entry of report.lanes)
      for (const observation of entry.observations) observation.id = '/private/path\ninjected'
    const lines = renderWarm99Diagnostics(report).split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe(
      'buck2-cache-join: lane=main-reader observation=0 eligible=1 hits=1 rate=1 complete=true gaps=0 consecutive=1',
    )
    expect(lines[1]).toContain('consecutive=2')
    expect(lines.join('\n')).not.toContain('injected')
    report.lanes[0]!.observations[0]!.eligible = 0
    report.lanes[0]!.observations[0]!.remoteHits = 0
    report.lanes[0]!.observations[0]!.meetsThreshold = false
    expect(renderWarm99Diagnostics(report)).toContain('eligible=0 hits=0 rate=unavailable')
  })
  it('uses each writer action timestamp rather than a cohort cutoff', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const writer = item.writers[0]!
      writer.actions = [199, 200, 201].map((endTime) =>
        actionFixture({
          buildId: writer.header.invocations[0]!.buildId,
          target: `test//:${endTime}`,
          digest: `${endTime}:1`,
          startedAt: 10,
          completedAt: endTime,
          endTime,
        }),
      )
      item.readers = [
        artifactFixture(
          false,
          writer.actions.map(({ target, digest }) => actionFixture({ target, digest })),
        ),
      ]
    }
    expect(evaluateWarm99({ manifest, loaded }).lanes[0]!.observations[0]).toMatchObject({
      complete: true,
      eligible: 1,
      remoteHits: 1,
      cold: 2,
    })
  })
  it.each(['upload', 'remote-hit'] as const)(
    'requires earlier exact trusted %s anchors',
    (source) => {
      for (const observedAt of [199, 200, 201])
        for (const lane of ['main-writer', 'merge_group', 'pr'] as const)
          for (const anchor of [
            'trusted',
            'disabled',
            'none',
            'different-configuration',
            'incomplete',
          ]) {
            if (anchor !== 'trusted' && (lane !== 'main-writer' || observedAt !== 199)) continue
            const manifest = manifestFixture()
            const loaded = loadedFixture(manifest)
            for (const item of loaded) {
              const writer = item.writers[0]!
              item.observation.writers[0]!.lane = lane
              writer.header.metadata.lane = lane
              writer.header.metadata.posture = lane === 'pr' ? 'read-only' : 'writer'
              if (anchor === 'disabled')
                writer.header.invocations[0]!.cacheReadPolicy = 'disabled-by-design'
              if (anchor === 'incomplete') writer.header.complete = false
              writer.actions = [
                actionFixture({
                  buildId: writer.header.invocations[0]!.buildId,
                  executionKind: source === 'upload' ? 1 : 3,
                  uploadOutcome: source === 'upload' ? 'uploaded' : 'not-uploaded',
                  cacheUploadResult: source === 'upload' ? 1 : 0,
                  startedAt: 10,
                  completedAt: observedAt,
                  endTime: observedAt,
                  uploadCompletedAt: source === 'upload' ? observedAt : null,
                }),
              ]
              if (anchor === 'different-configuration')
                writer.actions[0]!.configuration = 'linux#other'
              if (anchor === 'none') {
                item.writers = []
                item.observation.writers = []
              }
            }
            const eligible =
              anchor === 'trusted' && lane === 'main-writer' && observedAt < 200 ? 1 : 0
            const report = evaluateWarm99({ manifest, loaded })
            expect(report.accepted).toBe(eligible === 1)
            expect(report.lanes[0]!.observations[0]).toMatchObject({
              ...(anchor === 'incomplete' ? {} : { complete: true }),
              evidenceGap: anchor === 'incomplete' ? 1 : 0,
              eligible,
              remoteHits: eligible,
              cold: 1 - eligible,
            })
          }
    },
  )

  it('does not consume enabled lookup freshness with an earlier cache-off control', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const reader = item.readers[0]!
      const first = reader.header.invocations[0]!
      first.cacheReadPolicy = 'disabled-by-design'
      const next = {
        ...first,
        buildId: `${first.buildId}-enabled`,
        startedAt: 250,
        cacheReadPolicy: 'enabled' as const,
        freshRoot: false,
      }
      reader.header.invocations.push(next)
      reader.actions = [
        actionFixture({ buildId: first.buildId, executionKind: 1 }),
        actionFixture({ buildId: next.buildId, startedAt: 250, completedAt: 260, endTime: 260 }),
      ]
    }
    expect(evaluateWarm99({ manifest, loaded }).lanes[0]!.observations[0]).toMatchObject({
      complete: true,
      eligible: 1,
      remoteHits: 1,
      excluded: 1,
      cold: 0,
    })
  })
  it('excludes disabled readers and disabled uploads, preserving upload-only main/queue anchors', () => {
    for (const role of ['reader', 'writer'] as const) {
      for (const cacheReadPolicy of ['enabled', 'disabled-by-design', 'unknown'] as const) {
        const manifest = manifestFixture()
        const loaded = loadedFixture(manifest)
        for (const item of loaded) {
          const artifact = role === 'reader' ? item.readers[0]! : item.writers[0]!
          artifact.header.invocations[0]!.cacheReadPolicy = cacheReadPolicy
        }
        const disabled = cacheReadPolicy === 'disabled-by-design'
        expect(evaluateWarm99({ manifest, loaded }).lanes[0]!.observations[0]).toMatchObject({
          complete: true,
          eligible: disabled === true ? 0 : 1,
          remoteHits: disabled === true ? 0 : 1,
          excluded: disabled === true && role === 'reader' ? 1 : 0,
          cold: disabled === true && role === 'writer' ? 1 : 0,
          evidenceGap: 0,
        })
      }
    }
  })
  it('keeps materialization and Darwin TS outside eligible, cold, changed and upload-failure cohorts', () => {
    for (const executionKind of [1, 3, 8]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        item.writers = [
          artifactFixture(true, [
            actionFixture({
              category: 'tsgo_emit',
              executionKind: 1,
              cacheUploadResult: 1,
              uploadOutcome: 'uploaded',
              startedAt: 10,
              completedAt: 100,
              endTime: 100,
              uploadCompletedAt: 100,
            }),
            ...[...localMaterializationCategories, ...darwinUnsandboxedCategories].flatMap(
              (category) => [
                actionFixture({
                  category,
                  executionKind: 1,
                  cacheUploadResult: 1,
                  uploadOutcome: 'uploaded',
                  startedAt: 10,
                  completedAt: 100,
                  endTime: 100,
                  uploadCompletedAt: 100,
                }),
                actionFixture({
                  category,
                  executionKind: 1,
                  cacheUploadResult: 9,
                  uploadOutcome: 'failed',
                }),
              ],
            ),
          ]),
        ]
        item.readers = [
          artifactFixture(false, [
            actionFixture({ category: 'tsgo_emit' }),
            ...[...localMaterializationCategories, ...darwinUnsandboxedCategories].flatMap(
              (category) => [
                actionFixture({ category, executionKind }),
                actionFixture({ category, executionKind, digest: 'ffff:12' }),
                actionFixture({
                  category,
                  executionKind: 1,
                  cacheUploadResult: 9,
                  uploadOutcome: 'failed',
                }),
              ],
            ),
          ]),
        ]
      }
      const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
      expect(report.accepted).toBe(true)
      expect(report.lanes[0]?.observations[0]).toMatchObject({
        complete: true,
        eligible: 1,
        remoteHits: 1,
        hitRate: 1,
        excluded: 3 * (localMaterializationCategories.length + darwinUnsandboxedCategories.length),
        excludedByDesign: {
          'local-materialization-policy': 3 * localMaterializationCategories.length,
          'darwin-unsandboxed': 3 * darwinUnsandboxedCategories.length,
        },
        cold: 0,
        changed: 0,
        noncacheable: 0,
        uploadFailure: 0,
        evidenceGap: 0,
      })
    }
  })

  it('invalidates observations whose native invocations fall outside the job window', () => {
    for (const bound of ['start', 'finish'] as const) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const reader = item.readers[0]
        if (reader === undefined) throw new Error('fixture')
        if (bound === 'start') reader.header.metadata.startedAt = 201
        else reader.header.metadata.finishedAt = 299
      }
      const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
      expect(report.accepted).toBe(false)
      expect(report.lanes[0]?.observations[0]?.complete).toBe(false)
      expect(report.lanes[0]?.observations[0]?.evidenceGap).toBeGreaterThan(0)
    }
  })
  it('preserves the recovered Linux bootstrap cohort: eight cold emits, policy work and noncommands', () => {
    // Both recovered observations have this bootstrap shape in quality/weaver/test/store-gc.
    // Identity-first and invocation-first rules coincide when there is only one invocation.
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    const policyCounts: Record<string, number> = {
      pnpm_extract: 322,
      pnpm_store_entry: 309,
      pnpm_store_view: 10,
      package_tree: 10,
      pnpm_store_scc: 4,
      runtime_module: 2,
    }
    for (const item of loaded)
      item.readers = [
        artifactFixture(false, [
          ...Array.from({ length: 8 }, (_, index) =>
            actionFixture({ category: 'tsgo_emit', target: `test//:emit-${index}` }),
          ),
          ...Object.entries(policyCounts).flatMap(([category, count]) =>
            Array.from({ length: count }, (_, index) =>
              actionFixture({
                category,
                target: `test//:policy-${category}-${index}`,
                executionKind: 1,
              }),
            ),
          ),
          ...Array.from({ length: 718 }, () =>
            actionFixture({ commandAction: false, digest: null, executionKind: 4 }),
          ),
        ]),
      ]
    for (const observation of evaluateWarm99({ manifest, loaded }).lanes[0]!.observations)
      expect(observation).toMatchObject({
        complete: true,
        eligible: 0,
        remoteHits: 0,
        cold: 8,
        changed: 0,
        excluded: 657,
        noncacheable: 718,
        evidenceGap: 0,
      })
  })
  it('requires two observations for every lane and keeps Nix separate', () => {
    const manifest = manifestFixture(['main-reader', 'merge_group', 'pr'])
    const report = evaluateWarm99({ manifest: manifest, loaded: loadedFixture(manifest) })
    expect(report.accepted).toBe(true)
    expect(report.lanes.map((lane) => lane.consecutive)).toEqual([2, 2, 2])
    expect(report.lanes[0]?.observations[0]?.nixSubstitution.substituted).toBe(5)
    const single = manifestFixture(['main-reader'], 1)
    expect(evaluateWarm99({ manifest: single, loaded: loadedFixture(single) }).accepted).toBe(false)
  })
  it('strictly orders upload before reader (equality is cold) and matches configuration', () => {
    for (const mode of ['equal', 'later', 'configuration']) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const writer = item.writers[0]
        const action = writer?.actions[0]
        if (action === undefined) throw new Error('fixture')
        if (mode === 'configuration') action.configuration = 'linux#other'
        else action.uploadCompletedAt = mode === 'equal' ? 200 : 201
      }
      const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
      expect(report.accepted).toBe(false)
      expect(report.lanes[0]?.observations[0]?.eligible).toBe(0)
      expect(report.lanes[0]?.observations[0]?.cold).toBe(1)
    }
  })
  it('counts the first identity occurrence and excludes repetitions, never promoting local hits', () => {
    for (const kind of [3, 1, 7]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded)
        item.readers = [
          artifactFixture(false, [
            actionFixture({ executionKind: kind, startedAt: 200 }),
            actionFixture({ executionKind: 3, startedAt: 220, completedAt: 230, endTime: 230 }),
          ]),
        ]
      const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
      expect(report.lanes[0]?.observations[0]).toMatchObject({
        eligible: 1,
        remoteHits: kind === 3 ? 1 : 0,
        excluded: 1,
      })
      expect(report.accepted).toBe(kind === 3)
    }
  })
  it('raw remote hit wins over uploaded compact outcome', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded)
      item.readers = [
        artifactFixture(false, [
          actionFixture({
            outcome: 'uploaded',
            cacheUploadResult: 1,
            uploadOutcome: 'uploaded',
            uploadCompletedAt: 210,
          }),
        ]),
      ]
    expect(evaluateWarm99({ manifest: manifest, loaded: loaded }).accepted).toBe(true)
  })
  it('aggregates eligible readers only and reports earlier cold occurrence separately', () => {
    for (const start of [50, 200]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        item.observation.readers.push({
          lane: 'main-reader',
          summary: 'second.json',
          actions: 'second.gz',
        })
        const early = artifactFixture(false, [actionFixture({ executionKind: 1 })])
        early.header.metadata.startedAt = Math.min(start, 200)
        for (const invocation of early.header.invocations) invocation.startedAt = start
        item.readers = [early, artifactFixture()]
      }
      const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
      expect(report.lanes[0]?.observations[0]).toMatchObject({
        eligible: start === 50 ? 1 : 2,
        remoteHits: 1,
        cold: start === 50 ? 1 : 0,
      })
      expect(report.accepted).toBe(start === 50)
    }
  })
  it('counts A once and new B in invocation two, independent of serialized row order', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const writer = item.writers[0]!
      writer.actions.push({ ...writer.actions[0]!, target: 'test//:B' })
      writer.header.actionCount = writer.header.rows = 2
      writer.header.invocations[0]!.actionCount = 2
      const reader = artifactFixture(false, [
        actionFixture({
          buildId: 'later',
          target: 'test//:B',
          startedAt: 250,
          completedAt: 260,
          endTime: 260,
        }),
        actionFixture({
          buildId: 'later',
          identifier: '',
          executionKind: 10,
          digest: null,
          startedAt: 250,
          completedAt: 260,
          endTime: 260,
        }),
        actionFixture({ identifier: '' }),
      ])
      const first = reader.header.invocations[0]!
      first.actionCount = 1
      for (const action of reader.actions)
        if (action.buildId === 'later') action.buildId = `${first.buildId}-later`
      reader.header.invocations.push({
        ...first,
        buildId: `${first.buildId}-later`,
        startedAt: 250,
        freshRoot: false,
        actionCount: 2,
      })
      item.readers = [reader]
    }
    const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
    expect(report.accepted).toBe(true)
    expect(report.lanes[0]?.observations[0]).toMatchObject({
      eligible: 2,
      remoteHits: 2,
      excluded: 1,
    })
  })

  it('counts a new identity normally when its inputs were executed locally in an earlier invocation', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const writer = item.writers[0]!
      writer.actions.push({ ...writer.actions[0]!, target: 'test//:consumer' })
      writer.header.actionCount = writer.header.rows = 2
      writer.header.invocations[0]!.actionCount = 2
      // The first command produces the consumer's declared input locally.
      const reader = artifactFixture(false, [
        actionFixture({ executionKind: 1 }),
        actionFixture({
          buildId: 'consumer',
          target: 'test//:consumer',
          startedAt: 250,
          completedAt: 260,
          endTime: 260,
        }),
      ])
      const first = reader.header.invocations[0]!
      first.actionCount = 1
      for (const action of reader.actions)
        if (action.buildId === 'consumer') action.buildId = `${first.buildId}-consumer`
      reader.header.invocations.push({
        ...first,
        buildId: `${first.buildId}-consumer`,
        startedAt: 250,
        freshRoot: false,
        actionCount: 1,
      })
      item.readers = [reader]
    }
    expect(
      evaluateWarm99({ manifest: manifest, loaded: loaded }).lanes[0]?.observations[0],
    ).toMatchObject({
      complete: true,
      eligible: 2,
      remoteHits: 1,
      excluded: 0,
    })
  })

  it('treats a later command without native digest as a gap, including an unproven kind-10 key', () => {
    for (const executionKind of [1, 3, 7, 10]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const reader = artifactFixture(false, [
          actionFixture({ identifier: '' }),
          actionFixture({
            buildId: 'later',
            target: 'test//:new-key',
            identifier: '',
            executionKind,
            digest: null,
            startedAt: 250,
            completedAt: 260,
            endTime: 260,
          }),
        ])
        const first = reader.header.invocations[0]!
        first.actionCount = 1
        for (const action of reader.actions)
          if (action.buildId === 'later') action.buildId = `${first.buildId}-later`
        reader.header.invocations.push({
          ...first,
          buildId: `${first.buildId}-later`,
          startedAt: 250,
          freshRoot: false,
          actionCount: 1,
        })
        item.readers = [reader]
      }
      const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
      expect(report.accepted).toBe(false)
      expect(report.lanes[0]?.observations[0]).toMatchObject({ complete: false, evidenceGap: 1 })
    }
  })
  it('excludes a digestless kind-10 repetition after a digest-bearing local execution', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const reader = artifactFixture(false, [
        actionFixture({ identifier: 'compile', executionKind: 1 }),
        actionFixture({
          buildId: 'later',
          identifier: 'compile',
          executionKind: 10,
          digest: null,
          startedAt: 250,
          completedAt: 260,
          endTime: 260,
        }),
      ])
      const first = reader.header.invocations[0]!
      first.actionCount = 1
      for (const action of reader.actions)
        if (action.buildId === 'later') action.buildId = `${first.buildId}-later`
      reader.header.invocations.push({
        ...first,
        buildId: `${first.buildId}-later`,
        startedAt: 250,
        freshRoot: false,
        actionCount: 1,
      })
      item.readers = [reader]
    }
    expect(evaluateWarm99({ manifest, loaded }).lanes[0]?.observations[0]).toMatchObject({
      complete: true,
      eligible: 1,
      remoteHits: 0,
      excluded: 1,
      evidenceGap: 0,
    })
  })

  it('does not reuse configured-key evidence across identifiers or root scopes', () => {
    for (const mismatch of ['identifier', 'root', 'unknown-identifier']) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const reader = artifactFixture(false, [
          actionFixture({ identifier: 'first', executionKind: 1 }),
          actionFixture({
            buildId: 'later',
            identifier:
              mismatch === 'identifier'
                ? 'other'
                : mismatch === 'unknown-identifier'
                  ? null
                  : 'first',
            executionKind: 10,
            digest: null,
            startedAt: 250,
            completedAt: 260,
            endTime: 260,
          }),
        ])
        const first = reader.header.invocations[0]!
        first.rootId = 'a'.repeat(64)
        first.actionCount = 1
        for (const action of reader.actions)
          if (action.buildId === 'later') action.buildId = `${first.buildId}-later`
        reader.header.invocations.push({
          ...first,
          buildId: `${first.buildId}-later`,
          rootId: (mismatch === 'root' ? 'b' : 'a').repeat(64),
          startedAt: 250,
          freshRoot: mismatch === 'root',
          actionCount: 1,
        })
        item.readers = [reader]
      }
      expect(evaluateWarm99({ manifest, loaded }).lanes[0]?.observations[0]).toMatchObject({
        complete: false,
        evidenceGap: 1,
      })
    }
  })

  it('counts first occurrences independently in two explicitly attested roots', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const reader = artifactFixture(false, [
        actionFixture(),
        actionFixture({
          buildId: 'second-root',
          executionKind: 1,
          startedAt: 250,
          completedAt: 260,
          endTime: 260,
        }),
      ])
      const first = reader.header.invocations[0]!
      first.rootId = 'a'.repeat(64)
      first.actionCount = 1
      for (const action of reader.actions)
        if (action.buildId === 'second-root') action.buildId = `${first.buildId}-second-root`
      reader.header.invocations.push({
        ...first,
        buildId: `${first.buildId}-second-root`,
        rootId: 'b'.repeat(64),
        startedAt: 250,
        actionCount: 1,
      })
      item.readers = [reader]
    }
    expect(evaluateWarm99({ manifest, loaded }).lanes[0]?.observations[0]).toMatchObject({
      complete: true,
      eligible: 2,
      remoteHits: 1,
      excluded: 0,
    })
  })
  it('preserves a 198/200 threshold across roots and scopes all diagnostic counts', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      item.writers = [
        artifactFixture(true, [
          ...Array.from({ length: 100 }, (_, index) =>
            actionFixture({
              target: `test//:action-${index}`,
              uploadOutcome: 'uploaded',
              uploadCompletedAt: 100,
              startedAt: 10,
              completedAt: 100,
            }),
          ),
          actionFixture({
            target: 'test//:changed',
            uploadOutcome: 'uploaded',
            uploadCompletedAt: 100,
            startedAt: 10,
            completedAt: 100,
          }),
        ]),
      ]
      const perRoot = Array.from({ length: 2 }, (_, root) => [
        ...Array.from({ length: 100 }, (_, index) =>
          actionFixture({
            target: `test//:action-${index}`,
            buildId: root === 0 ? 'build' : 'second-root',
            executionKind: root === 1 && index < 2 ? 1 : 3,
          }),
        ),
        actionFixture({ target: 'test//:cold', buildId: root === 0 ? 'build' : 'second-root' }),
        actionFixture({
          target: 'test//:changed',
          digest: 'changed:1',
          buildId: root === 0 ? 'build' : 'second-root',
        }),
        actionFixture({
          target: 'test//:noncacheable',
          executionKind: 0,
          buildId: root === 0 ? 'build' : 'second-root',
        }),
      ])
      const reader = artifactFixture(false, perRoot.flat())
      const first = reader.header.invocations[0]!
      first.rootId = 'a'.repeat(64)
      first.actionCount = perRoot[0]!.length
      for (const action of reader.actions)
        if (action.buildId === 'second-root') action.buildId = `${first.buildId}-second-root`
      reader.header.invocations.push({
        ...first,
        buildId: `${first.buildId}-second-root`,
        rootId: 'b'.repeat(64),
      })
      item.readers = [reader]
    }
    const report = evaluateWarm99({ manifest, loaded })
    expect(report.accepted).toBe(true)
    expect(report.lanes[0]?.observations[0]).toMatchObject({
      complete: true,
      eligible: 200,
      remoteHits: 198,
      hitRate: 0.99,
      meetsThreshold: true,
      cold: 2,
      changed: 2,
      noncacheable: 2,
      excluded: 0,
    })
  })
  it('keeps same-path roots in distinct reader artifacts independent', () => {
    const manifest = manifestFixture()
    for (const observation of manifest.observations)
      observation.readers.push({
        lane: 'main-reader',
        summary: 'second-job.json',
        actions: 'second-job.gz',
      })
    const loaded = loadedFixture(manifest)
    for (const item of loaded)
      for (const reader of item.readers) reader!.header.invocations[0]!.rootId = 'a'.repeat(64)
    expect(evaluateWarm99({ manifest, loaded }).lanes[0]?.observations[0]).toMatchObject({
      complete: true,
      eligible: 2,
      remoteHits: 2,
    })
  })
  it('missing digest, metadata, nonfresh invocation, and missing reader invalidate', () => {
    for (const mode of [
      'digest',
      'fresh-local-digest',
      'metadata',
      'fresh',
      'missing',
      'invocation',
    ]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const artifact = item.readers[0]
        if (artifact === undefined) throw new Error('fixture')
        if (mode === 'digest') artifact.actions = [actionFixture({ digest: null })]
        if (mode === 'fresh-local-digest')
          artifact.actions = [actionFixture({ executionKind: 10, digest: null })]
        if (mode === 'metadata') artifact.header.metadata.runId = null
        if (mode === 'fresh') for (const inv of artifact.header.invocations) inv.freshRoot = false
        if (mode === 'invocation')
          for (const inv of artifact.header.invocations) inv.complete = false
        if (mode === 'missing') item.readers = [undefined]
      }
      expect(evaluateWarm99({ manifest: manifest, loaded: loaded }).accepted).toBe(false)
    }
  })
  it('gap breaks streak and zero eligible never passes', () => {
    const manifest = manifestFixture(['main-reader'], 4)
    const loaded = loadedFixture(manifest)
    const gap = loaded[2]
    if (gap === undefined) throw new Error('fixture')
    gap.writers = [undefined]
    expect(evaluateWarm99({ manifest: manifest, loaded: loaded }).lanes[0]?.consecutive).toBe(1)
    for (const item of loaded) item.readers = [artifactFixture(false, [])]
    expect(evaluateWarm99({ manifest: manifest, loaded: loaded }).accepted).toBe(false)
  })
  it('reports cold, changed, exclusions, noncacheable and upload failures separately', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      item.readers = [
        artifactFixture(false, [
          actionFixture(),
          actionFixture({ digest: 'changed:1' }),
          actionFixture({ target: '//:cold' }),
          actionFixture({ commandAction: false, digest: null }),
          actionFixture({ target: '//:noncacheable', executionKind: 0 }),
        ]),
      ]
      const writer = item.writers[0]
      if (writer === undefined) throw new Error('fixture')
      writer.actions.push(actionFixture({ uploadOutcome: 'failed', cacheUploadResult: 9 }))
    }
    const result = evaluateWarm99({ manifest: manifest, loaded: loaded }).lanes[0]?.observations[0]
    expect(result).toMatchObject({
      eligible: 1,
      changed: 1,
      cold: 1,
      excluded: 0,
      noncacheable: 2,
      uploadFailure: 1,
    })
  })
  it('99/100 meets threshold, 98/100 fails', () => {
    for (const hits of [99, 98]) {
      const manifest = manifestFixture()
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const writer = item.writers[0]
        if (writer === undefined) throw new Error('fixture')
        const invocation = writer.header.invocations[0]
        if (invocation === undefined) throw new Error('fixture')
        writer.actions = Array.from({ length: 100 }, (_, i) =>
          actionFixture({
            buildId: invocation.buildId,
            digest: `${i.toString(16)}:1`,
            executionKind: 1,
            uploadOutcome: 'uploaded',
            cacheUploadResult: 1,
            startedAt: 10,
            completedAt: 100,
            endTime: 100,
            uploadCompletedAt: 100,
          }),
        )
        writer.header.actionCount = 100
        writer.header.rows = 100
        invocation.actionCount = 100
        item.readers = [
          artifactFixture(
            false,
            Array.from({ length: 100 }, (_, i) =>
              actionFixture({ digest: `${i.toString(16)}:1`, executionKind: i < hits ? 3 : 1 }),
            ),
          ),
        ]
      }
      expect(evaluateWarm99({ manifest: manifest, loaded: loaded }).accepted).toBe(hits === 99)
    }
  })
  it('rejects equal/decreasing sequences, duplicate IDs and unknown lanes', () => {
    for (const mode of ['equal', 'decrease', 'id', 'lane']) {
      const manifest = manifestFixture()
      const second = manifest.observations[1]
      if (second === undefined) throw new Error('fixture')
      if (mode === 'equal') second.sequence = 0
      if (mode === 'decrease') second.sequence = -1
      if (mode === 'id') second.id = 'observation-0'
      const value: unknown = mode === 'lane' ? { ...manifest, enabledLanes: ['unknown'] } : manifest
      expect(() => decodeManifest(value)).toThrow()
    }
  })
})

describe('evidence trust boundaries', () => {
  it('rejects unsafe identities and metadata, wrong mapping and inconsistent timestamps/counters', () => {
    const artifact = artifactFixture()
    const raw = rawArtifact(artifact)
    const variants = [
      raw.replace('"target":"test//:test"', '"target":"/home/private/file"'),
      raw.replace('"configuration":"linux#1"', '"configuration":"/home/private/config"'),
      raw.replace('"digest":"abcd:12"', '"digest":"not-a-digest"'),
      raw.replace('"repo":"public/test"', '"repo":"/home/private/repo"'),
      raw.replace('"headSha":"' + 'a'.repeat(40) + '"', '"headSha":"secret"'),
      raw.replace('"runId":"1"', '"runId":"secret"'),
      raw.replace('"cacheOutcome":"remote-hit"', '"cacheOutcome":"local"'),
      raw.replace('"endTime":210', '"endTime":211'),
      raw.replace('"missingIdentityCount":0', '"missingIdentityCount":1'),
      raw.replace('"missingTimestampCount":0', '"missingTimestampCount":1'),
      raw.replace('"startedAt":200,"completedAt":300', '"startedAt":205,"completedAt":300'),
    ]
    for (const variant of variants) expect(() => decodeActionArtifact(variant)).toThrow()
  })
  it('rejects fabricated upload completion bounds', () => {
    const artifact = artifactFixture(true, [
      actionFixture({ cacheUploadResult: 1, uploadOutcome: 'uploaded', uploadCompletedAt: 209 }),
    ])
    expect(() => decodeActionArtifact(rawArtifact(artifact))).toThrow()
  })
  it('cannot replay one native reader invocation into two passing observations', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    const first = loaded[0]
    const second = loaded[1]
    if (first === undefined || second === undefined) throw new Error('fixture')
    second.readers = first.readers
    const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
    expect(report.accepted).toBe(false)
    expect(report.lanes[0]?.observations[1]?.evidenceGap).toBe(1)
  })
  it('never establishes eligibility from another repository', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const writer = item.writers[0]
      if (writer === undefined) throw new Error('fixture')
      writer.header.metadata.repo = 'unrelated/repo'
    }
    const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
    expect(report.accepted).toBe(false)
    expect(report.lanes[0]?.observations[0]?.evidenceGap).toBeGreaterThan(0)
  })
})

describe('known failure reporting', () => {
  it('retains writer and reader upload failures even when evidence is incomplete', () => {
    const manifest = manifestFixture()
    const loaded = loadedFixture(manifest)
    for (const item of loaded) {
      const failure = actionFixture({ cacheUploadResult: 9, uploadOutcome: 'failed' })
      const writer = artifactFixture(true, [failure])
      const reader = artifactFixture(false, [failure])
      writer.header.complete = false
      reader.header.complete = false
      item.writers = [writer]
      item.readers = [reader]
    }
    const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
    expect(report.accepted).toBe(false)
    expect(report.lanes[0]?.observations[0]).toMatchObject({
      uploadFailure: 2,
      evidenceGap: 2,
      eligible: 0,
    })
  })
})

describe('cache lane posture', () => {
  it('accepts writer-posture main and queue jobs as observed readers', () => {
    const manifest = manifestFixture(['main-writer', 'merge_group'])
    const loaded = loadedFixture(manifest)
    for (const item of loaded)
      for (const artifact of item.readers) {
        if (artifact === undefined) throw new Error('fixture')
        artifact.header.metadata.posture = 'writer'
      }
    const report = evaluateWarm99({ manifest: manifest, loaded: loaded })
    expect(report.accepted).toBe(true)
    expect(report.lanes.map((lane) => lane.consecutive)).toEqual([2, 2])
  })
  it('rejects queue or PR anchors, PR writer posture and read-only writer sources', () => {
    for (const mode of ['queue', 'pr-reader', 'pr-writer', 'readonly-source']) {
      const manifest = manifestFixture(['pr'])
      const loaded = loadedFixture(manifest)
      for (const item of loaded) {
        const writer = item.writers[0]
        const reader = item.readers[0]
        const ref = item.observation.writers[0]
        if (writer === undefined || reader === undefined || ref === undefined)
          throw new Error('fixture')
        if (mode === 'queue') {
          ref.lane = 'merge_group'
          writer.header.metadata.lane = 'merge_group'
        }
        if (mode === 'pr-reader') reader.header.metadata.posture = 'writer'
        if (mode === 'pr-writer') {
          ref.lane = 'pr'
          writer.header.metadata.lane = 'pr'
        }
        if (mode === 'readonly-source') {
          ref.lane = 'main-reader'
          writer.header.metadata.lane = 'main-reader'
          writer.header.metadata.posture = 'read-only'
        }
      }
      expect(evaluateWarm99({ manifest: manifest, loaded: loaded }).accepted).toBe(false)
    }
  })
})
