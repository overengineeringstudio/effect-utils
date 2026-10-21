import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { describe, expect, it } from 'vitest'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import dependencyBuck from '../../buck2/dependencies/BUCK.genie.ts'
import { rootWorkspacePackages } from '../../package.json.genie.ts'
import genieBuck from '../../packages/@overeng/genie/BUCK.genie.ts'
import type { GenieContext } from '../../packages/@overeng/genie/src/runtime/core.ts'
import {
  buck2TestLanes,
  buck2TypeScriptAdmissions,
  editorViewConsumerPackagePaths,
} from './typescript-admissions.ts'
import {
  buck2TypeScriptPackageProjection,
  type Buck2TypeScriptPackageProjection,
  workspacePackageSourceRoots,
  type Buck2WorkspacePackageGenerator,
} from './typescript-package-projection.ts'

const genieContext: GenieContext = { cwd: process.cwd(), location: '' }
const buck2ToolsBuck = readFileSync('packages/@overeng/buck2-tools/BUCK', 'utf8')

describe('nested Buck package ownership', () => {
  const packagePath = 'genie/buck2/fixtures/nested-package/parent'
  const output = (): string =>
    buck2TypeScriptPackageProjection({
      packageName: 'nested-fixture',
      packagePath,
      projectionSource: `${packagePath}/BUCK.genie.ts`,
      dependencyImporter: '//buck2/dependencies:importer_fixture',
      sourceRoots: ['src', 'bin'],
      workspacePackages: [
        { meta: { workspace: { memberPath: packagePath } }, data: { name: 'nested-fixture' } },
      ],
      authorities: [
        {
          projectFile: 'tsconfig.json',
          projectInputs: ['src/deeper/input.json', 'src/deeper/tsconfig.json'],
        },
      ],
      tests: [
        {
          name: 'test',
          runner: 'vitest',
          config: 'vitest.config.ts',
          configInputs: ['config.json'],
        },
      ],
      testDataRoots: [{ root: 'data', extensions: ['.json'] }],
      runtimeFiles: ['config.json'],
    }).stringify(genieContext)

  it('keeps parent and child destinations while depending on the nearest owner', () => {
    const rendered = output()
    expect(rendered).toContain('"bin/main.ts": "bin/main.ts",')
    expect(rendered).toContain(`"src/main.ts": "//${packagePath}/src:main.ts",`)
    expect(rendered).toContain(`"src/deeper/main.ts": "//${packagePath}/src/deeper:main.ts",`)
    expect(rendered).toContain(
      `"src/deeper/value$input.ts": "//${packagePath}/src/deeper:value__dollar__input.ts",`,
    )
    const exports = rendered.split('export_materialization_inputs([\n')[1]?.split('])')[0]
    expect(exports).toContain('"bin/main.ts",')
    expect(exports).not.toContain('"src/')
  })

  it('resolves test, snapshot, config, project, declaration and data inputs too', () => {
    const rendered = output()
    for (const file of [
      'main.test.jsx',
      '__snapshots__/main.test.jsx.snap',
      'vitest.config.ts',
      'tsconfig.json',
      'input.json',
      'types.d.ts',
    ]) {
      expect(rendered).toContain(`"src/deeper/${file}": "//${packagePath}/src/deeper:${file}",`)
    }
    expect(rendered).toContain(`"data/fixture.json": "//${packagePath}/data:fixture.json",`)
    for (const file of ['vitest.config.ts', 'config.json', 'package.json', 'tsconfig.json']) {
      expect(rendered).toContain(`"${file}": "${file}",`)
    }
  })

  it('carries declared runtime data in both package trees and rejects missing inputs', () => {
    const rendered = output()
    expect(stagedFilesOf({ output: rendered, tree: 'package_tree' })).toContain('config.json')
    expect(stagedFilesOf({ output: rendered, tree: 'test_package_tree' })).toContain('config.json')
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.aiGatewayConformance,
        runtimeFiles: ['missing.json'],
      }),
    ).toThrow('Runtime package file does not exist')
  })
})

const outputsByAdmission = Object.fromEntries(
  Object.entries(buck2TypeScriptAdmissions).map(([name, admission]) => [
    name,
    readFileSync(path.join(admission.packagePath, 'BUCK'), 'utf8'),
  ]),
) as Record<keyof typeof buck2TypeScriptAdmissions, string>

const admittedPackages = Object.entries(buck2TypeScriptAdmissions).map(([key, admission]) => ({
  output: outputsByAdmission[key as keyof typeof outputsByAdmission],
  dependencyView: admission.dependencyImporter.replace(':importer_', ':view_'),
  packagePath: admission.packagePath,
}))

describe('package-local BUCK provenance', () => {
  const render = (
    admission: Buck2TypeScriptPackageProjection,
    workspacePackages: readonly Buck2WorkspacePackageGenerator[] = rootWorkspacePackages,
  ): string =>
    buck2TypeScriptPackageProjection({ ...admission, workspacePackages }).stringify(genieContext)

  it('keeps every admitted package BUCK byte-identical when an unrelated package is added', () => {
    const syntheticPackage = {
      meta: { workspace: { memberPath: 'packages/@overeng/synthetic-unrelated' } },
      data: { name: '@overeng/synthetic-unrelated' },
    }
    const expandedWorkspace = [...rootWorkspacePackages, syntheticPackage]
    for (const admission of Object.values(buck2TypeScriptAdmissions)) {
      const baseline = render(admission)
      expect(render(admission, expandedWorkspace)).toBe(baseline)
      expect(baseline).not.toContain('# Semantic inputs:')
      expect(baseline).toContain(`# Projection source: ${admission.projectionSource}`)
      expect(baseline).toMatch(/^# Semantic fingerprint: sha256:[a-f0-9]{64}$/m)
      expect(baseline).toContain('# Regenerate: devenv tasks run genie:run')
    }
  })

  it('refreshes the affected projection and fingerprint without changing other package BUCK files', () => {
    const affected = buck2TypeScriptAdmissions.kdl
    const workspace: readonly Buck2WorkspacePackageGenerator[] = [
      ...rootWorkspacePackages,
      {
        meta: { workspace: { memberPath: 'packages/@overeng/synthetic-unrelated' } },
        data: { name: '@overeng/synthetic-unrelated' },
      },
    ]
    const changedWorkspace = workspace.map((member) =>
      member.meta.workspace.memberPath === affected.packagePath
        ? {
            ...member,
            data: {
              ...member.data,
              devDependencies: {
                ...member.data.devDependencies,
                '@overeng/synthetic-unrelated': 'workspace:*',
              },
            },
          }
        : member,
    )
    const fingerprint = (output: string): string | undefined =>
      output.match(/^# Semantic fingerprint: (.+)$/m)?.[1]
    const changedPackages = []
    for (const admission of Object.values(buck2TypeScriptAdmissions)) {
      const baseline = render(admission, workspace)
      const changed = render(admission, changedWorkspace)
      if (changed !== baseline) changedPackages.push(admission.packagePath)
      if (admission.packagePath === affected.packagePath) {
        expect(fingerprint(changed)).not.toBe(fingerprint(baseline))
      } else {
        expect(changed).toBe(baseline)
      }
    }
    expect(changedPackages).toEqual([affected.packagePath])
  })
})

// Deliberately re-derived from the working tree with the runners' own default selection
// (`*.{test,spec}.?(c|m)[jt]s?(x)`) instead of any projection helper: the point is to fail
// when the projection and the collectable set disagree, which a shared helper would hide.
const collectableTestSelection = /\.(?:spec|test)\.[cm]?[jt]sx?$/

const collectableTestModulesOf = ({
  packagePath,
  sourceRoots,
}: {
  readonly packagePath: string
  readonly sourceRoots: readonly string[]
}): readonly string[] => {
  const packageRoot = path.join(process.cwd(), packagePath)
  return sourceRoots
    .flatMap((sourceRoot) =>
      readdirSync(path.join(packageRoot, sourceRoot), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() === true)
        .map((entry) => path.relative(packageRoot, path.join(entry.parentPath, entry.name))),
    )
    .filter((file) => collectableTestSelection.test(file) === true)
    .toSorted()
}

const snapshotBaselineOf = (testModule: string): string =>
  path.posix.join(
    path.posix.dirname(testModule),
    '__snapshots__',
    `${path.posix.basename(testModule)}.snap`,
  )

/** Extensions the TypeScript source census admits; everything else is runner-only. */
const typeScriptSourceSelection = /\.(?:cts|js|mts|ts|tsx)$/

/**
 * Destinations one rendered `package_view` stages. Parsed out of the emitted Starlark rather
 * than read off the projection's semantic data: the file a lane actually runs in is the one
 * Buck reads, so the assertions have to be made against that text.
 */
const stagedFilesOf = ({
  output,
  tree,
}: {
  readonly output: string
  readonly tree: string
}): readonly string[] => {
  const target = output.split(`package_view(\n    name = "${tree}",\n`)[1]
  if (target === undefined) return []
  const files = target.split('    files = {\n')[1]?.split('\n    },')[0]
  if (files === undefined) throw new Error(`package_view ${tree} renders no files map`)
  return [...files.matchAll(/^ {8}"([^"]+)": /gmu)].map(([, destination]) => destination ?? '')
}

const targetBodyOf = ({
  output,
  name,
}: {
  readonly output: string
  readonly name: string
}): string => {
  const target = output.split(`\n    name = "${name}",\n`)[1]?.split('\n)\n')[0]
  if (target === undefined) throw new Error(`missing Buck target ${name}`)
  return target
}

const admittedTestLanes = Object.entries(buck2TypeScriptAdmissions).flatMap(([key, admission]) =>
  admission.tests === undefined
    ? []
    : [
        {
          output: outputsByAdmission[key as keyof typeof outputsByAdmission],
          packagePath: admission.packagePath,
          sourceRoots: admission.sourceRoots,
        },
      ],
)

const editorViewTarget = `editor_view_inputs(
    name = "editor_view_inputs",
    editor_inputs = ":editor_inputs",
    package_tree = ":package_tree",`

const retiredProviderTerms = [
  'pnpm_node_modules',
  'pnpm_editor_inputs',
  'buck2-materializer',
  'pnpm-deploy-normalizer',
  'pnpm-install-descriptor',
  'store_dir',
] as const

describe('generated dependency admission', () => {
  it('rejects package destinations that escape or alias the dependency tree', () => {
    for (const name of [
      '../escape',
      '@scope/../escape',
      '@scope',
      '@scope/',
      '@scope/@alias',
      '.pnpm',
      '.bin',
      'pkg/child',
      'pkg\\child',
    ]) {
      expect(() =>
        buck2TypeScriptPackageProjection({
          ...buck2TypeScriptAdmissions.kdl,
          generatedDependencies: { [name]: '//generated:package' },
        }),
      ).toThrow('unsafe generated dependency package name')
    }
  })

  it('rejects malformed and traversing absolute product labels', () => {
    for (const target of [
      '//generated:',
      '//../generated:package',
      '//generated//child:package',
      '//generated:../package',
      '//generated:bad\nlabel',
    ] as const) {
      expect(() =>
        buck2TypeScriptPackageProjection({
          ...buck2TypeScriptAdmissions.kdl,
          generatedDependencies: { 'generated-package': target },
        }),
      ).toThrow('normalized absolute Buck target')
    }
  })

  it('rejects competing generated and workspace package authorities', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.kdl,
        generatedDependencies: { 'generated-package': '//generated:package' },
        workspaceSiblings: [
          {
            packageName: 'generated-package',
            packagePath: 'packages/@overeng/kdl',
            distTarget: '//packages/@overeng/kdl:dist',
          },
        ],
      }),
    ).toThrow('both generated and a workspace sibling')
  })

  it('rejects generated packages shadowing manifest-declared dependencies', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.kdl,
        generatedDependencies: { effect: '//generated:package' },
      }),
    ).toThrow('both generated and manifest-declared')
  })
})

describe('source-only product package graph', () => {
  it('derives source roots from runtime exports and bins, not declaration or published paths', () => {
    const data = {
      name: 'workspace-source',
      exports: {
        '.': { types: './dist/types.d.ts', default: './runtime/main.ts' },
        './browser': { browser: './browser/main.tsx', default: './runtime/main.ts' },
        './style': './styles/main.css',
        './subpath/*': './runtime/*.ts',
        './package.json': './package.json',
      },
      bin: { tool: './commands/tool.ts' },
      publishConfig: { exports: { '.': './dist/main.js' } },
    }
    expect(workspacePackageSourceRoots({ data })).toEqual([
      'browser',
      'commands',
      'runtime',
      'styles',
    ])
  })

  it.each(['./dist/main.js', '../runtime/main.ts', './node_modules/runtime/main.ts'])(
    'refuses a non-source runtime boundary %s instead of guessing src',
    (target) => {
      expect(() =>
        workspacePackageSourceRoots({
          data: { name: 'missing-source', exports: { '.': { default: target } } },
        }),
      ).toThrow('has no source runtime target')
    },
  )

  it('requires an authoritative runtime source rather than declaration-only exports', () => {
    expect(() =>
      workspacePackageSourceRoots({
        data: { name: 'types-only', exports: { '.': { types: './dist/main.d.ts' } } },
      }),
    ).toThrow('has no source runtime entrypoints')
  })

  it('adds a recursive source view while leaving every npm and test graph boundary unchanged', () => {
    for (const [key, admission] of Object.entries<Buck2TypeScriptPackageProjection>(
      buck2TypeScriptAdmissions,
    )) {
      const output = buck2TypeScriptPackageProjection(admission).stringify(genieContext)
      const product = targetBodyOf({ output, name: 'product_package_tree' })
      expect(product).toContain(
        `dependency_view = "${admission.dependencyImporter?.replace(':importer_', ':product_view_')}"`,
      )
      expect(product).toContain('strip_project_references = True')
      expect(product).not.toMatch(/": "(?:[^"]+):(?:dist|package_tree)",/u)
      for (const sibling of admission.workspaceSiblings ?? []) {
        expect(product).toContain(
          `"node_modules/${sibling.packageName}/node_modules": "${
            sibling.distTarget?.replace(/:dist$/, ':product_package_tree') ??
            `//${sibling.packagePath}:product_package_tree`
          }",`,
        )
      }
      const previous = outputsByAdmission[key as keyof typeof outputsByAdmission]
      for (const name of [
        'node_modules',
        'package_tree',
        'typecheck',
        'dist',
        'dist-package',
        ...(admission.tests === undefined ? [] : ['test_package_tree']),
      ]) {
        expect(targetBodyOf({ output, name }), `${admission.packagePath}:${name}`).toBe(
          targetBodyOf({ output: previous, name }),
        )
      }
      expect(stagedFilesOf({ output, tree: 'product_package_tree' })).toEqual(
        stagedFilesOf({ output, tree: 'package_tree' }),
      )
    }
  })

  it('retains generated products that execute instead of replacing them with workspace sources', () => {
    const output = buck2TypeScriptPackageProjection(
      buck2TypeScriptAdmissions.effectRustFixtureConsumer,
    ).stringify(genieContext)
    for (const name of ['package_tree', 'product_package_tree']) {
      expect(targetBodyOf({ output, name })).toContain(
        '"effect-rust-fixture": "//rust/effect-rust-fixtures/service:service",',
      )
    }
  })

  it('derives declaration-backed sibling roots from its generator and rejects missing exports', () => {
    const siblingPath = 'genie/buck2/fixtures/nested-package/parent'
    const projection = (target: string): string =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.kdl,
        workspaceSiblings: [
          {
            packageName: 'nested-source',
            packagePath: siblingPath,
            distTarget: `//${siblingPath}:dist`,
          },
        ],
        workspacePackages: [
          {
            meta: { workspace: { memberPath: buck2TypeScriptAdmissions.kdl.packagePath } },
            data: { name: buck2TypeScriptAdmissions.kdl.packageName },
          },
          {
            meta: { workspace: { memberPath: siblingPath } },
            data: { name: 'nested-source', exports: { '.': { default: target } } },
          },
        ],
      }).stringify(genieContext)
    const product = targetBodyOf({
      output: projection('./bin/main.ts'),
      name: 'product_package_tree',
    })
    expect(product).toContain(`"//${siblingPath}:product_package_tree"`)
    expect(product).not.toContain(`"//${siblingPath}:dist"`)
    expect(() => projection('./bin/missing.ts')).toThrow('runtime source is missing')
    expect(() => projection('./missing/main.ts')).toThrow()
  })

  it('fails closed when a declaration sibling has no matching workspace generator', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.kdl,
        workspaceSiblings: [
          {
            packageName: 'unknown-source',
            packagePath: buck2TypeScriptAdmissions.kdl.packagePath,
            distTarget: '//packages/@overeng/kdl:dist',
          },
        ],
      }),
    ).toThrow('missing workspace source generator')
  })
})

describe('native TypeScript server dependency boundary', () => {
  it('extracts the native server directly from an external-only immutable dependency view', () => {
    const output = genieBuck.stringify(genieContext)
    const executable = targetBodyOf({
      output,
      name: 'typescript-api-server-product-executable',
    })
    expect(executable).toContain(
      'dependency_view = "//buck2/dependencies:external_view_packages_overeng_genie_b7534483be10"',
    )
    expect(executable).toContain('package_anchor = "typescript"')
    expect(executable).not.toContain('package_tree =')
    for (const platform of ['darwin-arm64', 'linux-arm64', 'linux-x64']) {
      expect(executable).toContain(`@typescript/typescript-${platform}/lib/tsc`)
      expect(executable).toContain(`@typescript/typescript-${platform}/lib"`)
    }
    expect(executable).toContain('support_destination = "bin"')
    expect(executable).toContain('recipe = "pnpm-lock:@typescript/typescript-platform/lib"')
    expect(executable).toContain('toolchain = "pnpm-lockfile:pnpm-lock.yaml"')
    expect(executable).toContain('target_platform = host_standalone_platform_label()')
    const product = targetBodyOf({ output, name: 'typescript-api-server-product' })
    expect(product).toContain('entrypoint = "bin/typescript-api-server"')
    expect(product).toContain('target_platform = host_standalone_platform_label()')
  })

  it('retains full read roots for both native executable and support extraction actions', () => {
    const rules = readFileSync('buck2/products/defs.bzl', 'utf8')
    const implementation = rules
      .split('def _package_tree_product_executable_impl(ctx):')[1]
      ?.split('_package_tree_product_executable = cache_guarded_rule(')[0]
    expect(implementation).toContain(
      'dependency_view = ctx.attrs.dependency_view[PnpmDeclaredClosureInfo]',
    )
    expect(implementation).toContain('cmd_args(dependency_view.node_modules,')
    expect(implementation?.match(/hidden = dependency_view\.read_roots/gu)).toHaveLength(2)
    expect(rules).toContain('"dependency_view": attrs.dep(providers = [PnpmDeclaredClosureInfo])')
    expect(rules).not.toContain('PackageTreeInfo')
  })
})

describe('declared-closure package projection', () => {
  it('publishes editor views for the complete workspace package registry', () => {
    expect(editorViewConsumerPackagePaths).toEqual(
      Object.values(buck2TypeScriptAdmissions)
        .map((admission) => admission.packagePath)
        .toSorted(),
    )
  })

  it('assigns nested workspace static sources to their nearest package boundary', () => {
    expect(outputsByAdmission.effectRpcTanstack).toContain(
      'exclude = STATIC_SOURCE_EXCLUDES + ["examples/basic/**"]',
    )
    expect(outputsByAdmission.effectRpcTanstackBasic).toContain('exclude = STATIC_SOURCE_EXCLUDES)')
  })

  it('resolves a nested workspace manifest through its own Buck package', () => {
    const parent = buck2TypeScriptAdmissions.effectRpcTanstack
    const nested = buck2TypeScriptAdmissions.effectRpcTanstackBasic
    const output = buck2TypeScriptPackageProjection({
      ...parent,
      workspacePackages: [
        ...rootWorkspacePackages.filter(
          (member) =>
            member.meta.workspace.memberPath !== parent.packagePath &&
            member.meta.workspace.memberPath !== nested.packagePath,
        ),
        {
          meta: { workspace: { memberPath: parent.packagePath } },
          data: {
            name: parent.packageName,
            dependencies: { [nested.packageName]: 'workspace:*' },
          },
        },
        {
          meta: { workspace: { memberPath: nested.packagePath } },
          data: { name: nested.packageName },
        },
      ],
    }).stringify(genieContext)
    const manifests = output.split('    workspace_manifests = [\n')[1]?.split('    ],')[0]
    const labels = manifests
      ?.trim()
      .split('\n')
      .map((line) => JSON.parse(line.trim().slice(0, -1)))
    expect(labels).toEqual([`//${nested.packagePath}:package.json`])
  })

  it('wires each admitted package only to its normalized dependency view', () => {
    for (const admitted of admittedPackages) {
      expect(admitted.output).toContain(`    actual = "${admitted.dependencyView}",`)
      expect(admitted.output).toContain(`    dependency_view = "${admitted.dependencyView}",`)
      expect(admitted.output).toContain('    actual = ":node_modules",')
      expect(admitted.output).not.toContain('//buck2/dependencies:importer_')
      expect(admitted.output).toContain(
        '    runtime = "//packages/@overeng/buck2-tools:package_tree_runtime",',
      )
      expect(admitted.output).toContain('    runtime_entry = "package-tree.ts",')
      expect(admitted.output).toContain('load("//buck2:editor_view.bzl", "editor_view_inputs")')
      expect(admitted.output).toContain(editorViewTarget)
      expect(admitted.output).toContain('    name = "dist-package",')
      expect(admitted.output.split('    name = "editor_view_inputs",')).toHaveLength(2)
      for (const retiredTerm of retiredProviderTerms) {
        expect(admitted.output).not.toContain(retiredTerm)
      }
    }
  })

  it('removes source-workspace references from compile and test package views', () => {
    const output = outputsByAdmission.kdl
    for (const tree of ['package_tree', 'test_package_tree']) {
      const target = output.split(`package_view(\n    name = "${tree}",\n`)[1]?.split('\n)\n')[0]
      expect(target).toContain('    strip_project_references = True,')
    }
  })

  it('overlays authoritative sibling declarations into compile and test package views', () => {
    for (const tree of ['package_tree', 'test_package_tree']) {
      const target = outputsByAdmission.notionReact.split(
        `package_view(\n    name = "${tree}",\n`,
      )[1]
      expect(target?.split('\n)\n')[0]).toContain(
        '        "node_modules/@overeng/notion-effect-client/dist": "//packages/@overeng/notion-effect-client:dist",',
      )
      expect(target?.split('\n)\n')[0]).toContain(
        '        "node_modules/@overeng/notion-effect-client/node_modules": "//packages/@overeng/notion-effect-client:package_tree",',
      )
    }
  })

  it('admits the complete recursive workspace closure for tui-react', () => {
    const tuiReactView = dependencyBuck.data.store.views.find(
      (view) => view.importer === 'packages/@overeng/tui-react',
    )
    expect(tuiReactView).toBeDefined()
    const admittedPackagePaths = new Set(admittedPackages.map(({ packagePath }) => packagePath))
    for (const label of Object.values(tuiReactView?.workspaceTrees ?? {})) {
      const packagePath = label.slice('//'.length, -':package_tree'.length)
      expect(admittedPackagePaths.has(packagePath), `missing projection for ${label}`).toBe(true)
    }
  })

  it('keeps package-tree runtime ownership out of the root Buck package', () => {
    const rootBuck = readFileSync('BUCK', 'utf8')
    expect(rootBuck).not.toContain('name = "package_tree_runtime",')
    expect(buck2ToolsBuck).toContain('name = "package_tree_runtime",')
    for (const admitted of admittedPackages) {
      for (const packagePath of admittedPackages.map(({ packagePath }) => packagePath)) {
        expect(
          admitted.output,
          `//${admitted.packagePath} still references root-owned //:${packagePath} inputs`,
        ).not.toContain(`//:${packagePath}/`)
      }
    }
  })

  it('leaves registry-backed CI dependency downloads uncached', () => {
    const workflow = ciWorkflow.stringify(genieContext)
    expect(workflow).not.toContain('Restore pnpm state')
    expect(workflow).not.toContain('Save pnpm state')
    expect(workflow).not.toContain('pnpm-state-v3-')
    expect(workflow).not.toContain('composition-state/pnpm-store-pure-v1')
  })

  it('projects package-specific declaration entrypoints for authoritative emits', () => {
    const output = buck2TypeScriptPackageProjection({
      ...buck2TypeScriptAdmissions.stylexTokens,
      authorities: [
        {
          declarationEntrypoint: 'src/tokens.stylex.d.ts',
          projectFile: 'tsconfig.json',
        },
      ],
    }).stringify(genieContext)

    expect(output).toContain('    declaration_entrypoint = "src/tokens.stylex.d.ts",')
  })

  it('preserves the legacy default-authority action argv byte for byte', () => {
    const output = buck2TypeScriptPackageProjection({
      ...buck2TypeScriptAdmissions.stylexTokens,
      authorities: [{ projectFile: 'tsconfig.json' }],
    }).stringify(genieContext)
    expect(output).not.toContain('    project_files = ')

    const materialization = readFileSync('buck2/materialization.bzl', 'utf8')
    const referenceArguments = materialization
      .split('    if ctx.attrs.strip_project_references:\n')[1]
      ?.split('    _add_mapped_sources(args, "--file", ctx.attrs.files)\n')[0]
    // Snapshot the actual Starlark command assembly: default authorities execute only
    // the legacy args.add, with every new argument guarded behind the non-default list.
    expect(referenceArguments).toBe(
      '        args.add("--strip-project-references", "true")\n' +
        '        # Preserve the existing action argv/cache key for default authorities.\n' +
        '        if ctx.attrs.project_files != ["tsconfig.json"]:\n' +
        '            for project in ctx.attrs.project_files:\n' +
        '                _require_relative_path(project, "authority project")\n' +
        '                args.add("--project", project)\n',
    )
    expect(materialization).toContain(
      '"project_files": attrs.list(attrs.string(), default = ["tsconfig.json"]),',
    )
  })

  it('strips the named authority used by both typecheck and emit', () => {
    const output = buck2TypeScriptPackageProjection({
      ...buck2TypeScriptAdmissions.stylexTokens,
      authorities: [{ projectFile: 'tsconfig.typecheck.json' }],
    }).stringify(genieContext)

    expect(output.match(/    project = "tsconfig.typecheck.json",/gu)).toHaveLength(2)
    for (const tree of ['package_tree', 'product_package_tree']) {
      const target = output.split(`    name = "${tree}",\n`)[1]?.split('\n)\n')[0]
      expect(target).toContain('    project_files = ["tsconfig.typecheck.json"],')
      expect(target).toContain('"tsconfig.typecheck.json": "tsconfig.typecheck.json",')
    }
  })

  it('projects an additional no-emit project under its own typecheck target', () => {
    const output = outputsByAdmission.reactInspector

    expect(output).toContain('    name = "strict_consumer_typecheck",')
    expect(output).toContain('    project = "tsconfig.strict-consumer.json",')
    expect(output.split('    name = "dist",')).toHaveLength(2)
    expect(output).toContain(
      '    project_files = ["tsconfig.json", "tsconfig.strict-consumer.json"],',
    )
  })

  it('refuses an unnamed additional authority project', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...buck2TypeScriptAdmissions.reactInspector,
        authorities: [
          {
            declarationEntrypoint: 'src/index.d.ts',
            projectFile: 'tsconfig.json',
          },
          {
            projectFile: 'tsconfig.strict-consumer.json',
            projectPath: 'packages/@overeng/react-inspector/tsconfig.strict-consumer.json',
          },
        ],
      }).stringify(genieContext),
    ).toThrow('must name its typecheck target')
  })

  it.each(['dist', 'package_tree', 'product_package_tree', 'test', 'test_collect'])(
    'refuses a typecheck target that collides with generated target %s',
    (typecheckTargetName) => {
      expect(() =>
        buck2TypeScriptPackageProjection({
          ...buck2TypeScriptAdmissions.kdl,
          authorities: [
            {
              declarationEntrypoint: 'src/mod.d.ts',
              projectFile: 'tsconfig.json',
              typecheckTargetName,
            },
          ],
        }).stringify(genieContext),
      ).toThrow('collides with generated Buck target')
    },
  )

  it('projects only package-local handwritten declarations into emit inputs', () => {
    expect(outputsByAdmission.tuiReact).toContain(
      '        "src/storybook/asset-modules.d.ts": "src/storybook/asset-modules.d.ts",',
    )
    expect(outputsByAdmission.utilsStorybook).toContain(
      '        "src/gate/virtual-modules.d.ts": "src/gate/virtual-modules.d.ts",',
    )
    expect(outputsByAdmission.utils).toContain(
      '        "src/node/stylex/mod-types.d.ts": "src/node/stylex/mod-types.d.ts",',
    )
    expect(outputsByAdmission.utils).toContain(
      '        "src/node/stylex/mod.js": "src/node/stylex/mod.js",',
    )
  })

  it('projects standalone consumers against external rules and declared node_modules', () => {
    const { dependencyImporter: _, ...admission } = buck2TypeScriptAdmissions.stylexTokens
    const output = buck2TypeScriptPackageProjection({
      ...admission,
      dependencyTarget: '//:node_modules',
      rulesCell: '@rules',
    }).stringify(genieContext)
    expect(output).toContain('load("@rules//buck2:materialization.bzl"')
    expect(output).toContain('load("@rules//buck2:typescript.bzl"')
    expect(output).toContain('    node_modules = "//:node_modules",')
    expect(output).toContain('    runtime = "@rules//:package_tree_runtime",')
    expect(output).toContain('load("@rules//buck2:package_tools.bzl", "npm_package_archive")')
    expect(output).toContain('    output = "overeng-stylex-tokens.tgz",')
    expect(output).not.toContain('//buck2/dependencies:view_')
  })
})

describe('same-cell label projection', () => {
  it('does not name the hub cell in generated packages or hub Starlark', () => {
    for (const admitted of admittedPackages) {
      expect(admitted.output).not.toMatch(/@?effect_utils\/\//u)
      expect(admitted.output).toContain('load("//buck2:materialization.bzl"')
      expect(admitted.output).toContain('load("//buck2:static_checks.bzl"')
      expect(admitted.output).toContain('    name = "static_sources",')
      expect(admitted.output).toContain('//buck2/dependencies:view_')
      expect(admitted.output).toContain('//packages/@overeng/buck2-tools:package_tree_runtime')
    }

    const hubSources = [
      'buck2/materialization.bzl',
      'buck2/static_checks.bzl',
      'buck2/platforms/defs.bzl',
      'buck2/products/defs.bzl',
      'buck2/toolchains/configured.bzl',
      'buck2/typescript.bzl',
    ].map((path) => readFileSync(path, 'utf8'))
    expect(hubSources.join('\n')).not.toMatch(/@?effect_utils\/\//u)
  })
})

describe('declared test lanes', () => {
  // Spelled out rather than spread-with-undefined: `exactOptionalPropertyTypes` makes an
  // explicit `tests: undefined` a different type from an absent lane declaration.
  const kdlAdmissionWithoutTests: Buck2TypeScriptPackageProjection = {
    authorities: buck2TypeScriptAdmissions.kdl.authorities,
    dependencyImporter: buck2TypeScriptAdmissions.kdl.dependencyImporter,
    packageName: buck2TypeScriptAdmissions.kdl.packageName,
    packagePath: buck2TypeScriptAdmissions.kdl.packagePath,
    projectionSource: buck2TypeScriptAdmissions.kdl.projectionSource,
    sourceRoots: buck2TypeScriptAdmissions.kdl.sourceRoots,
  }

  it('emits no test target, test rule load or test tree for a package without lanes', () => {
    const output =
      buck2TypeScriptPackageProjection(kdlAdmissionWithoutTests).stringify(genieContext)

    expect(output).not.toContain('load("//buck2:javascript.bzl"')
    expect(output).not.toContain('vitest_test(')
    expect(output).not.toContain('vitest_collect(')
    expect(output).not.toContain('    name = "test",')
    expect(output).not.toContain('test_package_tree')
    expect(stagedFilesOf({ output, tree: 'test_package_tree' })).toEqual([])
  })

  it('emits the default lane against the test tree that carries the config it loads', () => {
    expect(outputsByAdmission.kdl).toContain(
      'load("//buck2:javascript.bzl", "vitest_collect", "vitest_test")',
    )
    expect(outputsByAdmission.kdl).toContain(
      ['vitest_test(', '    name = "test",', '    package_tree = ":test_package_tree",'].join('\n'),
    )
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'test_package_tree' })).toContain(
      'vitest.config.ts',
    )
    expect(outputsByAdmission.kdl).toContain('    strip_project_references = True,')
    // The compile tree is what typecheck, emit and the editor read; a runner-only config in
    // there would rebuild every compile action for a file no compiler opens.
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'package_tree' })).not.toContain(
      'vitest.config.ts',
    )
    // The default config and timeouts are the rule's own defaults and stay unstated.
    expect(outputsByAdmission.kdl).not.toContain('    config = "vitest.config.ts",')
    expect(outputsByAdmission.kdl).not.toContain('    timeout_ms =')
  })

  it('stages the package-root files the declared config loads into the test tree only', () => {
    expect(
      stagedFilesOf({ output: outputsByAdmission.reactInspector, tree: 'test_package_tree' }),
    ).toContain('vitest.setup.ts')
    expect(
      stagedFilesOf({ output: outputsByAdmission.reactInspector, tree: 'package_tree' }),
    ).not.toContain('vitest.setup.ts')
  })

  it('stages the declared non-TypeScript test data the census cannot see', () => {
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'test_package_tree' })).toContain(
      'test-fixtures/expected_kdl/all_escapes.kdl',
    )
    expect(
      stagedFilesOf({ output: outputsByAdmission.notionMd, tree: 'test_package_tree' }),
    ).toContain('demo/showcase.nmd')
    // Fixture data is runner-only input; the compile tree never carries it.
    expect(stagedFilesOf({ output: outputsByAdmission.kdl, tree: 'package_tree' })).not.toContain(
      'test-fixtures/expected_kdl/all_escapes.kdl',
    )

    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        testDataRoots: [{ root: 'test-fixtures', extensions: ['.nmd'] }],
      }).stringify(genieContext),
    ).toThrow('Test data census found no .nmd inputs')
  })

  it('stages every collectable test module of every admitted lane in its test tree', () => {
    expect(admittedTestLanes.length).toBeGreaterThan(1)

    for (const lane of admittedTestLanes) {
      const modules = collectableTestModulesOf(lane)
      expect(
        modules.length,
        `//${lane.packagePath} declares a test lane but no source root holds a collectable module`,
      ).toBeGreaterThan(0)
      const testTree = stagedFilesOf({ output: lane.output, tree: 'test_package_tree' })
      const compileTree = stagedFilesOf({ output: lane.output, tree: 'package_tree' })
      for (const testModule of modules) {
        expect(
          testTree,
          `//${lane.packagePath}:test cannot collect ${testModule}: the test package tree omits it`,
        ).toContain(testModule)
        // A module the TypeScript census rejects is runner-only and stays out of compile.
        if (typeScriptSourceSelection.test(testModule) === false) {
          expect(
            compileTree,
            `//${lane.packagePath} compile tree carries the runner-only module ${testModule}`,
          ).not.toContain(testModule)
        }
      }
    }
  })

  it('stages the snapshot baseline of every staged test module in its test tree', () => {
    for (const lane of admittedTestLanes) {
      const testTree = stagedFilesOf({ output: lane.output, tree: 'test_package_tree' })
      const compileTree = stagedFilesOf({ output: lane.output, tree: 'package_tree' })
      for (const baseline of collectableTestModulesOf(lane)
        .map(snapshotBaselineOf)
        .filter((baseline) => existsSync(path.join(process.cwd(), lane.packagePath, baseline)))) {
        expect(
          testTree,
          `//${lane.packagePath}:test runs under CI=true and cannot write ${baseline}: the test package tree omits it`,
        ).toContain(baseline)
        expect(
          compileTree,
          `//${lane.packagePath} compile tree carries the baseline ${baseline}`,
        ).not.toContain(baseline)
      }
    }
  })

  it('splits the React Inspector JSX specs and live baselines out of its compile tree', () => {
    const testTree = stagedFilesOf({
      output: outputsByAdmission.reactInspector,
      tree: 'test_package_tree',
    })
    const compileTree = stagedFilesOf({
      output: outputsByAdmission.reactInspector,
      tree: 'package_tree',
    })
    const jsxSpecs = [
      'src/object-inspector/ObjectInspector.spec.jsx',
      'src/object/ObjectName.spec.jsx',
      'src/object/ObjectValue.spec.jsx',
      'src/table-inspector/getHeaders.spec.jsx',
      'src/tree-view/pathUtils.spec.jsx',
    ]

    expect(testTree.filter((file) => file.endsWith('.spec.jsx'))).toEqual(jsxSpecs)
    for (const specModule of jsxSpecs) {
      expect(compileTree).not.toContain(specModule)
    }
    // Exactly the baselines whose `.spec.jsx` module still exists; the three retired
    // `.spec.js` baselines were collected by nothing and are deleted, not staged.
    expect(testTree.filter((file) => file.endsWith('.snap'))).toEqual([
      'src/object-inspector/__snapshots__/ObjectInspector.spec.jsx.snap',
      'src/object/__snapshots__/ObjectName.spec.jsx.snap',
      'src/object/__snapshots__/ObjectValue.spec.jsx.snap',
    ])
    expect(outputsByAdmission.reactInspector).not.toContain('.spec.js.snap')
    for (const orphan of [
      'src/object-inspector/__snapshots__/ObjectInspector.spec.js.snap',
      'src/object/__snapshots__/ObjectName.spec.js.snap',
      'src/object/__snapshots__/ObjectValue.spec.js.snap',
    ]) {
      expect(
        existsSync(path.join(process.cwd(), 'packages/@overeng/react-inspector', orphan)),
        `${orphan} has no collecting module and must not be committed`,
      ).toBe(false)
    }
    // A `.jsx` spec is a test module, not a TypeScript source: it must not reach emit inputs.
    expect(outputsByAdmission.reactInspector).not.toContain('    "src/object/ObjectName.spec.jsx",')
  })

  it('rejects live host paths in a cacheable Vitest lane', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', configuredExternalInputs: ['NODE_PTY_PACKAGE'] }],
      }).stringify(genieContext),
    ).toThrow('requires provider-backed external inputs')
  })

  it('projects the node Vitest runtime only with its attested executable', () => {
    expect(outputsByAdmission.notionDatasourceSync).toContain('    vitest_runtime = "node",')
    expect(outputsByAdmission.notionDatasourceSync).toContain(
      '        "NODE_BIN": "//buck2/toolchains:tool_node",',
    )

    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', vitestRuntime: 'node' }],
      }).stringify(genieContext),
    ).toThrow('requires a declared NODE_BIN tool')
  })

  it('refuses a Vitest lane that reads the ambient environment', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', inheritedEnv: ['NOTION_API_TOKEN'] }],
      }).stringify(genieContext),
    ).toThrow('derived collection action requires every input in the action identity')
  })

  it('refuses test selections the package tree does not carry', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test', runner: 'vitest', testFiles: ['e2e/live.test.ts'] }],
      }).stringify(genieContext),
    ).toThrow('declare e2e in sourceRoots')
  })

  it('requires the default execution lane to be named test', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmissionWithoutTests,
        tests: [{ name: 'test_upstream', runner: 'vitest' }],
      }).stringify(genieContext),
    ).toThrow('must be named test')
  })

  it('carries the declared lane into the semantic fingerprint', () => {
    const fingerprintOf = (output: string): string =>
      output.split('# Semantic fingerprint: ')[1]?.split('\n')[0] ?? ''
    const withoutTests =
      buck2TypeScriptPackageProjection(kdlAdmissionWithoutTests).stringify(genieContext)
    const withLongerTimeout = buck2TypeScriptPackageProjection({
      ...buck2TypeScriptAdmissions.kdl,
      tests: [{ name: 'test', runner: 'vitest', timeoutMs: 60_000 }],
    }).stringify(genieContext)
    const withStaticCollection = buck2TypeScriptPackageProjection({
      ...buck2TypeScriptAdmissions.kdl,
      tests: [{ name: 'test', runner: 'vitest', staticCollection: true }],
    }).stringify(genieContext)

    expect(fingerprintOf(outputsByAdmission.kdl)).not.toBe(fingerprintOf(withoutTests))
    expect(fingerprintOf(outputsByAdmission.kdl)).not.toBe(fingerprintOf(withLongerTimeout))
    expect(fingerprintOf(outputsByAdmission.kdl)).not.toBe(fingerprintOf(withStaticCollection))
  })

  it('names the JavaScript action runtime as the runner every lane executes', () => {
    const rules = readFileSync('buck2/javascript.bzl', 'utf8')
    expect(
      rules.split('default = "//packages/@overeng/buck2-tools:javascript_action_runtime",'),
    ).toHaveLength(3)
    expect(buck2ToolsBuck).toContain('    name = "javascript_action_runtime",')
  })
})

describe('derived test collection targets', () => {
  const kdlAdmission = buck2TypeScriptAdmissions.kdl

  it('projects one collection sibling per Vitest lane from the same validated inputs', () => {
    for (const lane of admittedTestLanes) {
      const executions = lane.output.split('\nvitest_test(\n').length - 1
      const collections = lane.output.split('\nvitest_collect(\n').length - 1
      expect(collections, `//${lane.packagePath} projects ${executions} lanes`).toBe(executions)
    }

    // Same package tree, same visibility, same derived name: one declaration, two targets.
    expect(outputsByAdmission.kdl).toContain(
      [
        'vitest_collect(',
        '    name = "test_collect",',
        '    package_tree = ":test_package_tree",',
        '    visibility = ["PUBLIC"],',
        ')',
      ].join('\n'),
    )
    expect(outputsByAdmission.kdl).not.toContain('static_parse')
  })

  it('carries every collect-supported attribute and drops the two the rule rejects', () => {
    const output = buck2TypeScriptPackageProjection({
      ...kdlAdmission,
      tests: [
        {
          name: 'test',
          runner: 'vitest',
          excludes: ['src/mod.test.ts'],
          env: { KDL_MODE: 'strict' },
          hookTimeoutMs: 45_000,
          labels: ['local-only'],
          timeoutMs: 120_000,
          vitestRuntime: 'node',
          staticCollection: true,
          tools: { NODE_BIN: '//buck2/toolchains:tool_node' },
          writableDirectories: { KDL_WORKSPACE: 'kdl' },
        },
      ],
    }).stringify(genieContext)
    const collectBlock = output.split('\nvitest_collect(\n')[1]?.split('\n)\n')[0] ?? ''

    expect(collectBlock).toContain('    name = "test_collect",')
    expect(collectBlock).toContain('        "KDL_MODE": "strict",')
    expect(collectBlock).toContain('        "src/mod.test.ts",')
    expect(collectBlock).toContain('        "local-only",')
    expect(collectBlock).toContain('        "NODE_BIN": "//buck2/toolchains:tool_node",')
    expect(collectBlock).toContain('    vitest_runtime = "node",')
    expect(collectBlock).toContain('    static_parse = True,')
    expect(collectBlock).toContain('        "KDL_WORKSPACE": "kdl",')
    // Both bound a running test; the collect rule has no attribute for either.
    expect(collectBlock).not.toContain('timeout_ms')
    expect(collectBlock).not.toContain('hook_timeout_ms')
    // The execution lane keeps them, so the two targets differ in exactly those attributes.
    const executionBlock = output.split('\nvitest_test(\n')[1]?.split('\n)\n')[0] ?? ''
    expect(executionBlock).toContain('    timeout_ms = 120000,')
    expect(executionBlock).toContain('    hook_timeout_ms = 45000,')
  })

  it('refuses a declared lane that collides with a derived collection target', () => {
    expect(() =>
      buck2TypeScriptPackageProjection({
        ...kdlAdmission,
        tests: [
          { name: 'test', runner: 'vitest' },
          { name: 'test_collect', runner: 'vitest' },
        ],
      }).stringify(genieContext),
    ).toThrow('Duplicate test target names')
  })

  it('records every declared lane census exactly once as bounded or source-owned', () => {
    for (const admitted of admittedTestLanes) {
      const lane = buck2TestLanes.find(
        (candidate) =>
          candidate.packagePath === admitted.packagePath &&
          candidate.target.endsWith(':test') === true,
      )
      expect(lane, `no default registry lane for //${admitted.packagePath}`).toBeDefined()
      const census = collectableTestModulesOf(admitted)
      expect(lane?.testFiles).toEqual(census)

      const selected = new Set(lane?.selectedTestFiles ?? [])
      const excluded = new Set(lane?.excludes ?? [])
      const bounded = census.filter(
        (module) => selected.has(module) === true && excluded.has(module) === false,
      )
      const source = census.filter((module) => bounded.includes(module) === false)
      const recordedSource = [
        ...(lane?.unboundedFiles ?? []),
        ...Object.keys(lane?.sourceOwners ?? {}),
      ].toSorted()

      expect(new Set(recordedSource).size).toBe(recordedSource.length)
      expect(recordedSource).toEqual(source)
      expect([...bounded, ...recordedSource].toSorted()).toEqual(census)
    }
  })

  it('projects the effect-schema-form-aria census as one wholly bounded JSX lane', () => {
    const admitted = admittedTestLanes.find(
      ({ packagePath }) => packagePath === 'packages/@overeng/effect-schema-form-aria',
    )
    expect(admitted).toBeDefined()
    const census = admitted === undefined ? [] : collectableTestModulesOf(admitted)
    const lane = buck2TestLanes.find(
      ({ packagePath }) => packagePath === 'packages/@overeng/effect-schema-form-aria',
    )

    expect(census).toEqual(['src/mod.unit.test.tsx'])
    expect(lane?.selectedTestFiles).toEqual(census)
    expect(lane?.excludes).toEqual([])
    expect(lane?.sourceOwners).toEqual({})
    expect(lane?.unboundedFiles).toEqual([])
    expect(lane?.unboundedTaskName).toBeUndefined()
    expect(admitted?.output).toContain(
      ['vitest_test(', '    name = "test",', '    package_tree = ":test_package_tree",'].join('\n'),
    )
    expect(admitted?.output).toContain(
      [
        'vitest_collect(',
        '    name = "test_collect",',
        '    package_tree = ":test_package_tree",',
      ].join('\n'),
    )
  })

  it('keeps the JSX census inside the partition it stages', () => {
    const reactInspector = admittedTestLanes.find(
      (lane) => lane.packagePath === 'packages/@overeng/react-inspector',
    )
    expect(reactInspector).toBeDefined()
    const census = reactInspector === undefined ? [] : collectableTestModulesOf(reactInspector)
    const lane = buck2TestLanes.find(
      (candidate) => candidate.packagePath === 'packages/@overeng/react-inspector',
    )

    expect(census).toContain('src/object/ObjectName.spec.jsx')
    // The JSX specs are staged and bounded, never quietly excluded into an unbounded task.
    expect(lane?.excludes).toEqual([])
    expect(lane?.unboundedTaskName).toBeUndefined()
  })
})
