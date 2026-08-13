import { readFileSync } from 'node:fs'

import { buck2Projection } from '../../../../genie/buck2/mod.ts'
import {
  closureCompilerAbi,
  discoverPnpmTaskClosureInputs,
  supportedPnpmVersion,
} from '../../buck2-tools/src/mod.ts'
import {
  conservativeFullImporterRoots,
  decodePnpmLockfile,
  discoverPackageSources,
  materializerPolicyDigest,
  materializerPolicyProjection,
  packagePath,
  regenerationCommand,
  relevantPackageNamesForPlan,
  semanticInputs,
  targetForSources,
  targetLabel,
  workspaceLabelsFor,
} from './target.ts'

const parseYaml = (text: string): unknown =>
  (Bun as unknown as { readonly YAML: { readonly parse: (input: string) => unknown } }).YAML.parse(
    text,
  )

const lockfile = decodePnpmLockfile(
  parseYaml(readFileSync(new URL('../../../../pnpm-lock.yaml', import.meta.url), 'utf8')),
)
const workspacePolicy = parseYaml(
  readFileSync(new URL('../../../../pnpm-workspace.yaml', import.meta.url), 'utf8'),
)
const importer = lockfile.importers[packagePath]
if (importer === undefined) throw new Error(`pnpm importer is missing: ${packagePath}`)
const target = targetForSources(discoverPackageSources(new URL('../', import.meta.url)))
const roots = conservativeFullImporterRoots(importer)
const request = {
  label: targetLabel,
  importerId: packagePath,
  mode: 'conservative-full-importer-plan',
  platformRole: 'exec',
  platform: {
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
    nodeAbi: '137',
  },
  roots,
} as const

// Selection only: the compiler API guarantees this plan contains no content,
// context, or task IDs. Buck must materialize and hash each normalized package
// tree before a second, authoritative compile can occur.
const inputPlan = discoverPnpmTaskClosureInputs({
  pnpmVersion: supportedPnpmVersion,
  lockfile,
  request,
  workspaceLabels: workspaceLabelsFor(lockfile),
})
const relevantPackageNames = relevantPackageNamesForPlan(inputPlan)
const materializerPolicy = materializerPolicyProjection({
  workspaceValue: workspacePolicy,
  relevantPackageNames,
})

export default buck2Projection.closureDescriptor({
  packagePath,
  target,
  resolvedClosure: {
    authority: {
      status: 'non-authoritative-input-plan',
      authoritativeCompiler: 'buck-action-required',
      remoteAdmission: 'disabled',
    },
    compilerAbi: closureCompilerAbi,
    request,
    inputPlan,
    relevantPackageNames,
    materializerPolicy,
    materializerPolicyDigest: materializerPolicyDigest({
      workspaceValue: workspacePolicy,
      relevantPackageNames,
    }),
  },
  semanticInputs: [
    ...semanticInputs,
    'packages/@overeng/tui-core/buck2/typescript-input-plan.json.genie.ts',
  ],
  regenerationCommand,
  source: 'packages/@overeng/tui-core/buck2/typescript-input-plan.json.genie.ts',
})
