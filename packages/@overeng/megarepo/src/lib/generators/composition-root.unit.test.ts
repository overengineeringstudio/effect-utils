import { createHash } from 'node:crypto'

import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import * as fc from 'effect/testing/FastCheck'
import { expect } from 'vitest'

import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  COMPOSITION_GENERATION_MANIFEST_PATH,
  CompositionGenerationManifestSchema,
  CompositionRootOutputSchema,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  decodeCompositionRootInput,
  encodeBuckMemberManifestJson,
  encodeCompositionRootInput,
  encodeCompositionRootOutput,
  generateCompositionRoot,
  type BuckMemberManifest,
  type CompositionRootInput,
  type GeneratedCompositionFile,
} from './composition-root.ts'

const decoder = new TextDecoder()
const text = (file: GeneratedCompositionFile): string => decoder.decode(file.bytes)
const filesByPath = (input: CompositionRootInput): ReadonlyMap<string, GeneratedCompositionFile> =>
  new Map(generateCompositionRoot(input).files.map((file) => [file.path, file]))

const capability = (toolId: string) => ({
  toolId,
  protocol: 'native-executable/v1',
  flakePackage: `${toolId}-package`,
  executable: `bin/${toolId}`,
})

const manifest = ({
  cell,
  memberKey = cell,
  projectIgnore = [],
  capabilities = [],
}: {
  readonly cell: string
  readonly memberKey?: string
  readonly projectIgnore?: ReadonlyArray<string>
  readonly capabilities?: BuckMemberManifest['capabilities']
}): BuckMemberManifest => ({
  schemaVersion: 1,
  cell,
  mount: `repos/${memberKey}`,
  projectIgnore,
  capabilities,
})

const input = ({
  members,
  platformHubCell = 'alpha',
  isolationDir,
  cacheSections,
  resolvedBuckExecutable = '/nix/store/00000000000000000000000000000000-buck2/bin/buck2',
}: Pick<CompositionRootInput, 'members'> &
  Partial<Omit<CompositionRootInput, 'schemaVersion' | 'members'>>): CompositionRootInput => ({
  schemaVersion: 1,
  members,
  platformHubCell,
  isolationDir,
  cacheSections,
  resolvedBuckExecutable,
})

const alphaMember = {
  memberKey: 'alpha',
  manifest: manifest({ cell: 'alpha' }),
} as const

describe('buck2 member manifest', () => {
  it('uses the tracked public filename and canonically decodes and encodes v1', () => {
    expect(BUCK_MEMBER_MANIFEST_FILENAME).toBe('buck2-member.json')
    const decoded = decodeBuckMemberManifest({
      schemaVersion: 1,
      cell: 'alpha',
      mount: 'repos/alpha',
      projectIgnore: ['generated', '**/dist', 'generated'],
      capabilities: [capability('zeta'), capability('alpha')],
    })
    expect(decoded.projectIgnore).toEqual(['**/dist', 'generated'])
    expect(decoded.capabilities.map((item) => item.toolId)).toEqual(['alpha', 'zeta'])

    const encoded = encodeBuckMemberManifestJson(decoded)
    expect(encoded.endsWith('\n')).toBe(true)
    expect(decodeBuckMemberManifestJson(encoded)).toEqual(decoded)
  })

  it.each([
    ['unknown field', { ...manifest({ cell: 'alpha' }), unknown: true }],
    ['invalid cell', { ...manifest({ cell: 'bad/cell' }), cell: 'bad/cell' }],
    ['invalid mount', { ...manifest({ cell: 'alpha' }), mount: '/repos/alpha' }],
    ['parent ignore', { ...manifest({ cell: 'alpha' }), projectIgnore: ['../escape'] }],
    ['comma ignore', { ...manifest({ cell: 'alpha' }), projectIgnore: ['a,b'] }],
    [
      'invalid capability executable',
      {
        ...manifest({ cell: 'alpha' }),
        capabilities: [{ ...capability('tsgo'), executable: '../tsgo' }],
      },
    ],
    [
      'invalid capability protocol',
      {
        ...manifest({ cell: 'alpha' }),
        capabilities: [{ ...capability('tsgo'), protocol: 'native executable/v1' }],
      },
    ],
    [
      'invalid flake package',
      {
        ...manifest({ cell: 'alpha' }),
        capabilities: [{ ...capability('tsgo'), flakePackage: 'packages/tsgo' }],
      },
    ],
    [
      'duplicate tool ids',
      { ...manifest({ cell: 'alpha' }), capabilities: [capability('tsgo'), capability('tsgo')] },
    ],
    [
      'unknown capability field',
      {
        ...manifest({ cell: 'alpha' }),
        capabilities: [{ ...capability('tsgo'), ambientPath: true }],
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(() => decodeBuckMemberManifest(value)).toThrow()
  })
})

describe('composition root goldens', () => {
  it('generates the exact single-member root', () => {
    const output = filesByPath(
      input({
        members: [
          {
            memberKey: 'alpha',
            manifest: manifest({ cell: 'alpha', projectIgnore: ['.git', '**/dist'] }),
          },
        ],
        cacheSections: [
          {
            section: 'buck2_re_client',
            entries: [
              { key: 'tls', value: 'false' },
              { key: 'action_cache_address', value: 'grpc://cache.example:1234' },
            ],
          },
          {
            section: 'buck2',
            entries: [
              { key: 'digest_algorithms', value: 'SHA256' },
              { key: 'default_allow_cache_upload', value: 'true' },
            ],
          },
        ],
      }),
    )

    expect(text(output.get('.buckconfig')!)).toBe(`[cells]
  workspace = .
  prelude = prelude
  toolchains = toolchains
  none = none
  alpha = repos/alpha

[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbcode = none
  fbsource = none
  fbcode_macros = none
  buck = none

[external_cells]
  prelude = bundled

[parser]
  target_platform_detector_spec = target:alpha//...->alpha//buck2/platforms:host_platform

[build]
  execution_platforms = alpha//buck2/platforms:host_execution_platform

[buck2]
  default_allow_cache_upload = true
  digest_algorithms = SHA256

[buck2_re_client]
  action_cache_address = grpc://cache.example:1234
  tls = false

[project]
  ignore = **/node_modules,**/node_modules/**,**/target,**/target/**,.buck2/capabilities.candidate.*,.devenv,.git,buck-out,node_modules,repos/.staging-*,repos/alpha/**/dist,repos/alpha/.git,target,tmp
`)
    expect(output.get('.buckroot')?.bytes).toHaveLength(0)
    expect(output.get('BUCK')?.bytes).toHaveLength(0)
    expect(output.get('none/BUCK')?.bytes).toHaveLength(0)
    expect(text(output.get('toolchains/BUCK')!)).toBe(
      'load("@prelude//toolchains:demo.bzl", "system_demo_toolchains")\n\nsystem_demo_toolchains()\n',
    )
  })

  it('generates the exact two-member cell and detector shape', () => {
    const config = text(
      filesByPath(
        input({
          members: [
            {
              memberKey: 'beta-source',
              manifest: manifest({
                cell: 'beta',
                memberKey: 'beta-source',
                projectIgnore: ['generated'],
              }),
            },
            alphaMember,
          ],
        }),
      ).get('.buckconfig')!,
    )

    expect(config).toBe(`[cells]
  workspace = .
  prelude = prelude
  toolchains = toolchains
  none = none
  alpha = repos/alpha
  beta = repos/beta-source

[cell_aliases]
  config = prelude
  ovr_config = prelude
  fbcode = none
  fbsource = none
  fbcode_macros = none
  buck = none

[external_cells]
  prelude = bundled

[parser]
  target_platform_detector_spec = target:alpha//...->alpha//buck2/platforms:host_platform \\
    target:beta//...->alpha//buck2/platforms:host_platform

[build]
  execution_platforms = alpha//buck2/platforms:host_execution_platform

[project]
  ignore = **/node_modules,**/node_modules/**,**/target,**/target/**,.buck2/capabilities.candidate.*,.devenv,.git,buck-out,node_modules,repos/.staging-*,repos/beta-source/generated,target,tmp
`)
  })

  it('emits only the six canonical aliases and the required toolchains declaration', () => {
    const output = filesByPath(input({ members: [alphaMember] }))
    const config = text(output.get('.buckconfig')!)
    const aliasSection = config.match(/\[cell_aliases\]\n([\s\S]*?)\n\n\[external_cells\]/u)?.[1]
    expect(aliasSection?.split('\n')).toEqual([
      '  config = prelude',
      '  ovr_config = prelude',
      '  fbcode = none',
      '  fbsource = none',
      '  fbcode_macros = none',
      '  buck = none',
    ])
    expect(config).not.toMatch(/^\s+root\s*=/mu)
    expect(text(output.get('toolchains/BUCK')!)).toContain('system_demo_toolchains()')
  })
})

describe('composition determinism and detector coverage', () => {
  it('is byte-for-byte deterministic under every unordered input permutation', () => {
    const first = generateCompositionRoot(
      input({
        members: [
          {
            memberKey: 'beta',
            manifest: manifest({
              cell: 'beta',
              projectIgnore: ['generated', '**/dist'],
              capabilities: [capability('zeta'), capability('alpha')],
            }),
          },
          alphaMember,
        ],
        cacheSections: [
          {
            section: 'z_cache',
            entries: [
              { key: 'z', value: '2' },
              { key: 'a', value: '1' },
            ],
          },
          { section: 'a_cache', entries: [{ key: 'enabled', value: 'true' }] },
        ],
      }),
    )
    const permuted = generateCompositionRoot(
      input({
        members: [
          alphaMember,
          {
            memberKey: 'beta',
            manifest: manifest({
              cell: 'beta',
              projectIgnore: ['**/dist', 'generated'],
              capabilities: [capability('alpha'), capability('zeta')],
            }),
          },
        ],
        cacheSections: [
          { section: 'a_cache', entries: [{ key: 'enabled', value: 'true' }] },
          {
            section: 'z_cache',
            entries: [
              { key: 'a', value: '1' },
              { key: 'z', value: '2' },
            ],
          },
        ],
      }),
    )
    expect(permuted).toEqual(first)
  })

  it.prop(
    'emits exactly one detector clause for every member cell',
    [
      fc.uniqueArray(
        fc
          .stringMatching(/^[a-z][a-z0-9_]{0,7}$/u)
          .filter((cell) => !['workspace', 'prelude', 'toolchains', 'none'].includes(cell)),
        { minLength: 1, maxLength: 12 },
      ),
    ],
    ([cells]) => {
      const hub = cells[0]!
      const config = text(
        filesByPath(
          input({
            members: cells.map((cell) => ({ memberKey: cell, manifest: manifest({ cell }) })),
            platformHubCell: hub,
          }),
        ).get('.buckconfig')!,
      )
      const detectorCells = [...config.matchAll(/target:([A-Za-z][A-Za-z0-9_-]*)\/\/\.\.\.-/gu)]
        .map((match) => match[1])
        .sort()
      expect(detectorCells).toEqual([...cells].sort())
      expect(detectorCells).toHaveLength(new Set(cells).size)
    },
    { fastCheck: { numRuns: 100 } },
  )
})

describe('ignore projection', () => {
  it('prefixes member ignores, sorts them, and deduplicates repeated contributions', () => {
    const config = text(
      filesByPath(
        input({
          members: [
            {
              memberKey: 'alpha',
              manifest: manifest({
                cell: 'alpha',
                projectIgnore: ['generated', 'generated', '**/dist'],
              }),
            },
          ],
        }),
      ).get('.buckconfig')!,
    )
    const ignore = config.match(/^  ignore = (.*)$/mu)?.[1]?.split(',') ?? []
    expect(ignore.filter((entry) => entry === 'repos/alpha/generated')).toHaveLength(1)
    expect(ignore).toContain('repos/alpha/**/dist')
    expect(ignore).toContain('repos/.staging-*')
    expect(ignore).toContain('.buck2/capabilities.candidate.*')
    expect(ignore).toEqual([...ignore].sort())
  })
})

describe('generation manifest and output schema', () => {
  it('hashes every generated non-manifest file and excludes self recursion', () => {
    const output = generateCompositionRoot(input({ members: [alphaMember] }))
    expect(output.files.at(-1)?.path).toBe('.buckconfig')
    expect(output.files.map((file) => file.path)).toEqual([
      '.buckroot',
      '.megarepo/bin/buck2',
      '.megarepo/composition-generation.json',
      'BUCK',
      'none/BUCK',
      'toolchains/BUCK',
      '.buckconfig',
    ])
    const manifestFile = output.files.find(
      (file) => file.path === COMPOSITION_GENERATION_MANIFEST_PATH,
    )!
    const generationManifest = Schema.decodeUnknownSync(CompositionGenerationManifestSchema, {
      onExcessProperty: 'error',
    })(JSON.parse(text(manifestFile)))
    expect(generationManifest.files).toHaveLength(output.files.length - 1)
    expect(generationManifest.files.map((file) => file.path)).not.toContain(
      COMPOSITION_GENERATION_MANIFEST_PATH,
    )
    for (const entry of generationManifest.files) {
      const generated = output.files.find((file) => file.path === entry.path)!
      expect(entry.mode).toBe(generated.mode)
      expect(entry.sha256).toBe(
        `sha256:${createHash('sha256').update(generated.bytes).digest('hex')}`,
      )
    }
  })

  it('canonically encodes input defaults and round-trips output bytes', () => {
    const rawInput = input({
      members: [{ memberKey: 'beta', manifest: manifest({ cell: 'beta' }) }, alphaMember],
    })
    const encodedInput = encodeCompositionRootInput(rawInput)
    expect(encodedInput.members.map((member) => member.manifest.cell)).toEqual(['alpha', 'beta'])
    expect(encodedInput.isolationDir).toBe('megarepo')
    expect(encodedInput.cacheSections).toEqual([])

    const output = generateCompositionRoot(rawInput)
    expect(encodeCompositionRootOutput(output)).toEqual(output)
  })

  it('strictly decodes output bytes and rejects unknown output fields', () => {
    const output = generateCompositionRoot(input({ members: [alphaMember] }))
    expect(Schema.decodeUnknownSync(CompositionRootOutputSchema)(output)).toEqual(output)
    expect(() =>
      Schema.decodeUnknownSync(CompositionRootOutputSchema, { onExcessProperty: 'error' })({
        ...output,
        generatedAt: 'ambient-time',
      }),
    ).toThrow()
  })
})

describe('composition input failures', () => {
  it.each([
    [
      'mount disagreement',
      input({
        members: [{ memberKey: 'beta', manifest: manifest({ cell: 'alpha' }) }],
      }),
    ],
    [
      'duplicate member keys',
      input({
        members: [alphaMember, alphaMember],
      }),
    ],
    [
      'duplicate cells',
      input({
        members: [
          alphaMember,
          { memberKey: 'beta', manifest: manifest({ cell: 'alpha', memberKey: 'beta' }) },
        ],
      }),
    ],
    [
      'reserved cell collision',
      input({
        members: [
          {
            memberKey: 'workspace-member',
            manifest: manifest({ cell: 'workspace', memberKey: 'workspace-member' }),
          },
        ],
        platformHubCell: 'workspace',
      }),
    ],
    ['missing platform hub', input({ members: [alphaMember], platformHubCell: 'beta' })],
    [
      'duplicate cache sections',
      input({
        members: [alphaMember],
        cacheSections: [
          { section: 'buck2', entries: [] },
          { section: 'buck2', entries: [] },
        ],
      }),
    ],
    [
      'duplicate cache keys',
      input({
        members: [alphaMember],
        cacheSections: [
          {
            section: 'buck2',
            entries: [
              { key: 'digest_algorithms', value: 'SHA256' },
              { key: 'digest_algorithms', value: 'SHA1' },
            ],
          },
        ],
      }),
    ],
    [
      'generator-owned cache section',
      input({
        members: [alphaMember],
        cacheSections: [{ section: 'cells', entries: [{ key: 'evil', value: 'path' }] }],
      }),
    ],
    ['unknown input field', { ...input({ members: [alphaMember] }), currentTime: 123 }],
  ])('rejects %s', (_name, value) => {
    expect(() => decodeCompositionRootInput(value)).toThrow()
  })

  it('defaults isolation to megarepo and accepts an explicit fixed value', () => {
    expect(decodeCompositionRootInput(input({ members: [alphaMember] })).isolationDir).toBe(
      'megarepo',
    )
    expect(
      decodeCompositionRootInput(input({ members: [alphaMember], isolationDir: 'fleet-buck' }))
        .isolationDir,
    ).toBe('fleet-buck')
  })
})
