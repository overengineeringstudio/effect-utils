import { describe, expect, it } from 'vitest'

import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { buck2Projection } from './mod.ts'

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
    })

    expect(output.stringify(genieContext)).toMatchInlineSnapshot(`
      "# GENERATED FILE - DO NOT EDIT. Edit the corresponding .genie.ts source.
      # Projection schema version: 2
      # Projection generator: effect-utils/genie/buck2
      # Semantic fingerprint: sha256:2ba5268b762e25ad765e405dbae7e6a205106363b336a7c6555b25cddae10181
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
      }),
    ).toThrow('Duplicate Buck target name: unit_test')

    expect(() =>
      buck2Projection.packageFile({
        packagePath: 'packages/@overeng/example',
        macro: { load: '//buck2:defs.bzl', symbol: 'package_task' },
        targets: [{ ...target, sources: ['src/a.ts', 'src/a.ts'] }],
        semanticInputs: [],
        regenerationCommand: 'genie',
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
    })

    expect(JSON.parse(output.stringify(genieContext))).toEqual({
      schemaVersion: 2,
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
      })

    expect(make('genie').data.provenance.semanticFingerprint).toBe(
      make('devenv tasks run genie:run').data.provenance.semanticFingerprint,
    )
  })
})
