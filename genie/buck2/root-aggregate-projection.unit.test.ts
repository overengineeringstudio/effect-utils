import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import fixtureBuckProjection from '../../rust/effect-rust-fixtures/BUCK.genie.ts'
import fixtureTsconfig from '../../rust/effect-rust-fixtures/tsconfig.json.genie.ts'
import {
  planRootBuckAggregates,
  rootBuckAggregateProjection,
  rootRepositoryValidationSourceExcludes,
  rootRepositoryValidationSourceGlobs,
} from './root-aggregate-projection.ts'
import { authoritativeBuck2TypeScriptProjects } from './typescript-admissions.ts'

describe('root Buck aggregate projection', () => {
  it('derives quick and all from the authoritative target sets', () => {
    expect(
      planRootBuckAggregates({
        typecheckTargets: ['//packages/@example/alpha:typecheck'],
        distTargets: ['//packages/@example/alpha:dist'],
        testTargets: ['//packages/@example/alpha:test'],
      }),
    ).toEqual({
      quick: [
        '//packages/@example/alpha:typecheck',
        '//rust/effect-rust-fixtures:typecheck',
        ':weaver_check',
        ':weaver_version_smoke',
        '//buck2/static:check',
      ],
      all: [
        ':quick',
        '//packages/@example/alpha:dist',
        '//packages/@example/alpha:test',
        '//buck2/toolchains:archive_tool',
        '//buck2/toolchains:product_tool',
        '//rust/effect-rust-fixtures/wasm-adapter:wasm-smoke-node',
        '//rust/effect-rust-fixtures/wasm-adapter:wasm-smoke-bun',
        '//rust/effect-rust-fixtures/napi-adapter:napi-smoke-node',
        '//rust/effect-rust-fixtures/napi-adapter:napi-smoke-bun',
        '//rust/effect-rust-fixtures/app:app-smoke-node',
        '//rust/effect-rust-fixtures/app:app-smoke-bun',
      ],
    })
  })

  it('renders the stack-head root targets and registry aggregates together', () => {
    const output = rootBuckAggregateProjection().stringify({ cwd: '/repo', location: '' })

    expect(output).toContain('name = "editor_view_inputs"')
    expect(output).toContain('name = "static_sources"')
    expect(output).toContain('name = "quick"')
    expect(output).toContain('name = "all"')
    expect(output).toContain('check_aggregate(')
    expect(output).toContain('weaver_checks(')
  })

  it('checks every fixture TypeScript source against the real package declarations', () => {
    const output = fixtureBuckProjection.stringify({ cwd: '/repo', location: '' })

    expect(output).toContain('name = "typecheck"')
    expect(output).toContain('glob(["**/*.ts"], exclude = ["**/*.genie.ts"])')
    expect(output).toContain('dependency_view = "//packages/@overeng/effect-rust:node_modules"')
    expect(output).toContain(
      '"node_modules/@overeng/effect-rust/dist": "//packages/@overeng/effect-rust:dist"',
    )
    expect(output).toContain(
      '"node_modules/@overeng/effect-rust/node_modules": "//packages/@overeng/effect-rust:package_tree"',
    )
    expect(output).toContain(
      '"effect-rust-fixture": "//rust/effect-rust-fixtures/service:service"',
    )
    expect(fixtureTsconfig.data.include).toEqual(['**/*.ts'])
    expect(fixtureTsconfig.data.exclude).toEqual(['**/*.genie.ts'])
    expect(fixtureTsconfig.data.compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noEmit: true,
    })
  })

  it('stages nested generators and helpers outside admitted package directories', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'root-validation-sources-'))
    try {
      for (const relativePath of [
        'scripts/unadmitted/nested-tool.genie.ts',
        'scripts/unadmitted/helper.ts',
        'node_modules/ignored.genie.ts',
        'buck-out/ignored.genie.ts',
      ]) {
        const absolutePath = path.join(root, relativePath)
        mkdirSync(path.dirname(absolutePath), { recursive: true })
        writeFileSync(absolutePath, 'export default {}\n')
      }

      const excluded = rootRepositoryValidationSourceExcludes.map(
        (pattern) => new Bun.Glob(pattern),
      )
      const matched = new Set<string>()
      for (const pattern of rootRepositoryValidationSourceGlobs) {
        for await (const relativePath of new Bun.Glob(pattern).scan({
          cwd: root,
          onlyFiles: true,
        })) {
          if (excluded.some((glob) => glob.match(relativePath)) === false) matched.add(relativePath)
        }
      }

      expect(matched).toEqual(
        new Set(['scripts/unadmitted/helper.ts', 'scripts/unadmitted/nested-tool.genie.ts']),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('adds static validation and measured Weaver gates to the production quick target set', () => {
    expect(planRootBuckAggregates().quick).toEqual([
      ...authoritativeBuck2TypeScriptProjects.map((project) => project.typecheckTarget),
      '//rust/effect-rust-fixtures:typecheck',
      ':weaver_check',
      ':weaver_version_smoke',
      '//buck2/static:check',
    ])
  })
})
