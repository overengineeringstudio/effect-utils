import { describe, expect, it } from 'vitest'

import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { buck2Projection, buck2SemanticFingerprint } from './mod.ts'

const genieContext: GenieContext = {
  cwd: '/workspace',
  location: 'packages/@overeng/example',
}

const target = {
  name: 'unit_test',
  kind: 'vitest',
  platform: 'x86_64-linux',
  sources: ['src/z.test.ts', 'src/a.ts'],
  configs: ['vitest.config.ts', 'tsconfig.json'],
  deps: ['//packages/@overeng/utils:library', '//packages/@overeng/core:library'],
  closureDescriptor: 'buck2/unit-test.closure.json',
} as const

describe('buck2Projection.packageFile', () => {
  it('renders stable package-local BUCK text with explicit inputs and provenance', () => {
    const output = buck2Projection.packageFile({
      packagePath: 'packages/@overeng/example',
      macro: {
        load: '//buck2/rules:package_targets.bzl',
        symbol: 'package_task',
      },
      targets: [target],
      semanticInputs: ['pnpm-lock.yaml', 'packages/@overeng/example/package.json.genie.ts'],
      regenerationCommand: 'devenv tasks run genie:run',
      source: 'packages/@overeng/example/BUCK.genie.ts',
    })

    expect(output.stringify(genieContext)).toMatchInlineSnapshot(`
      "# Projection source: packages/@overeng/example/BUCK.genie.ts
      # Projection schema version: 3
      # Projection generator: effect-utils/genie/buck2
      # Semantic fingerprint: sha256:9c39a8c8c9d712a74162b985aca424865ea51b9fb267d61094b137cd21608779
      # Semantic inputs: packages/@overeng/example/package.json.genie.ts, pnpm-lock.yaml
      # Regenerate: devenv tasks run genie:run

      load("//buck2/rules:package_targets.bzl", "package_task")

      package_task(
          name = "unit_test",
          package_path = "packages/@overeng/example",
          kind = "vitest",
          platform = "x86_64-linux",
          sources = [
              "src/a.ts",
              "src/z.test.ts",
          ],
          configs = [
              "tsconfig.json",
              "vitest.config.ts",
          ],
          deps = [
              "//packages/@overeng/core:library",
              "//packages/@overeng/utils:library",
          ],
          closure_descriptor = "buck2/unit-test.closure.json",
      )
      "
    `)
  })

  it('is invariant to set-like input and target ordering', () => {
    const left = buck2Projection.packageFile({
      packagePath: 'packages/@overeng/example',
      macro: { load: '//buck2:defs.bzl', symbol: 'package_task' },
      targets: [target, { ...target, name: 'typecheck', kind: 'tsgo' }],
      semanticInputs: ['z', 'a'],
      regenerationCommand: 'genie',
      source: 'BUCK.genie.ts',
    })
    const right = buck2Projection.packageFile({
      packagePath: 'packages/@overeng/example',
      macro: { load: '//buck2:defs.bzl', symbol: 'package_task' },
      targets: [
        {
          ...target,
          name: 'typecheck',
          kind: 'tsgo',
          sources: target.sources.toReversed(),
          configs: target.configs.toReversed(),
          deps: target.deps.toReversed(),
        },
        { ...target, sources: target.sources.toReversed() },
      ],
      semanticInputs: ['a', 'z'],
      regenerationCommand: 'genie',
      source: 'BUCK.genie.ts',
    })

    expect(left.stringify(genieContext)).toBe(right.stringify(genieContext))
  })

  it('rejects duplicate target names and duplicate explicit inputs', () => {
    expect(() =>
      buck2Projection.packageFile({
        packagePath: 'packages/@overeng/example',
        macro: { load: '//buck2:defs.bzl', symbol: 'package_task' },
        targets: [target, target],
        semanticInputs: [],
        regenerationCommand: 'genie',
        source: 'BUCK.genie.ts',
      }),
    ).toThrow('Duplicate Buck target name: unit_test')

    expect(() =>
      buck2Projection.packageFile({
        packagePath: 'packages/@overeng/example',
        macro: { load: '//buck2:defs.bzl', symbol: 'package_task' },
        targets: [{ ...target, sources: ['src/a.ts', 'src/a.ts'] }],
        semanticInputs: [],
        regenerationCommand: 'genie',
        source: 'BUCK.genie.ts',
      }),
    ).toThrow('Duplicate source in target unit_test: src/a.ts')
  })
})

describe('buck2Projection.closureDescriptor', () => {
  it('wraps already-resolved closure data in stable schema-versioned JSON', () => {
    const output = buck2Projection.closureDescriptor({
      packagePath: 'packages/@overeng/example',
      target,
      resolvedClosure: {
        roots: ['vitest@4.1.9'],
        packages: {
          'vitest@4.1.9': { integrity: 'sha512-example', dependencies: [] },
        },
      },
      semanticInputs: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
      regenerationCommand: 'devenv tasks run genie:run',
      source: 'packages/@overeng/example/closure.json.genie.ts',
    })

    expect(JSON.parse(output.stringify(genieContext))).toEqual({
      schemaVersion: 3,
      packagePath: 'packages/@overeng/example',
      target: {
        name: 'unit_test',
        kind: 'vitest',
        platform: 'x86_64-linux',
        sources: ['src/a.ts', 'src/z.test.ts'],
        configs: ['tsconfig.json', 'vitest.config.ts'],
        deps: ['//packages/@overeng/core:library', '//packages/@overeng/utils:library'],
        closureDescriptor: 'buck2/unit-test.closure.json',
      },
      closure: {
        roots: ['vitest@4.1.9'],
        packages: {
          'vitest@4.1.9': { dependencies: [], integrity: 'sha512-example' },
        },
      },
      provenance: {
        generator: 'effect-utils/genie/buck2',
        regenerationCommand: 'devenv tasks run genie:run',
        semanticFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        semanticInputs: ['pnpm-lock.yaml', 'pnpm-workspace.yaml'],
        source: 'packages/@overeng/example/closure.json.genie.ts',
        warning: 'GENERATED FILE - DO NOT EDIT',
      },
    })
  })

  it('canonicalizes closure object keys and fingerprints closure changes', () => {
    const make = (resolvedClosure: {
      readonly roots: readonly string[]
      readonly metadata: Readonly<Record<string, string>>
    }) =>
      buck2Projection.closureDescriptor({
        packagePath: 'packages/@overeng/example',
        target,
        resolvedClosure,
        semanticInputs: [],
        regenerationCommand: 'genie',
        source: 'closure.json.genie.ts',
      })

    const left = make({ roots: ['a'], metadata: { z: 'last', a: 'first' } })
    const reordered = make({ metadata: { a: 'first', z: 'last' }, roots: ['a'] })
    const changed = make({ roots: ['b'], metadata: { a: 'first', z: 'last' } })

    expect(left.stringify(genieContext)).toBe(reordered.stringify(genieContext))
    expect(left.data.provenance.semanticFingerprint).not.toBe(
      changed.data.provenance.semanticFingerprint,
    )
  })

  it('does not treat the regeneration command as semantic closure data', () => {
    const make = (regenerationCommand: string) =>
      buck2Projection.closureDescriptor({
        packagePath: 'packages/@overeng/example',
        target,
        resolvedClosure: { roots: ['vitest@4.1.9'] },
        semanticInputs: ['pnpm-lock.yaml'],
        regenerationCommand,
        source: 'closure.json.genie.ts',
      })

    expect(make('genie').data.provenance.semanticFingerprint).toBe(
      make('devenv tasks run genie:run').data.provenance.semanticFingerprint,
    )
  })

  it('binds generator identity and schema version into the semantic fingerprint', () => {
    const fingerprint = (generator: string, schemaVersion: number) =>
      buck2SemanticFingerprint({ generator, schemaVersion, semanticData: { value: 'same' } })

    expect(fingerprint('effect-utils/genie/buck2', 3)).not.toBe(
      fingerprint('effect-utils/genie/buck2', 4),
    )
    expect(fingerprint('effect-utils/genie/buck2', 3)).not.toBe(fingerprint('another-generator', 3))
  })
})
