import { withJavaScriptCandidates } from '../../../genie/buck2/javascript-candidates.ts'
import { javaScriptProductsFor } from '../../../genie/buck2/javascript-product-registry.ts'
import type { Buck2TypeScriptAdmission } from '../../../genie/buck2/typescript-admissions.ts'
import { buck2TypeScriptPackageProjection } from '../../../genie/buck2/typescript-package-projection.ts'

export const buck2TypeScriptAdmission = {
  dependencyImporter: '//buck2/dependencies:importer_packages_overeng_megarepo_b89b4c18f380',
  packageName: '@overeng/megarepo',
  packagePath: 'packages/@overeng/megarepo',
  projectionSource: 'packages/@overeng/megarepo/BUCK.genie.ts',
  sourceRoots: ['src', 'bin'],
  workspaceSiblings: [
    {
      packageName: '@overeng/effect-path',
      packagePath: 'packages/@overeng/effect-path',
      distTarget: '//packages/@overeng/effect-path:dist',
    },
    {
      packageName: '@overeng/kdl',
      packagePath: 'packages/@overeng/kdl',
      distTarget: '//packages/@overeng/kdl:dist',
    },
    {
      packageName: '@overeng/kdl-effect',
      packagePath: 'packages/@overeng/kdl-effect',
      distTarget: '//packages/@overeng/kdl-effect:dist',
    },
    {
      packageName: '@overeng/otel-contract',
      packagePath: 'packages/@overeng/otel-contract',
      distTarget: '//packages/@overeng/otel-contract:dist',
    },
    {
      packageName: '@overeng/tui-core',
      packagePath: 'packages/@overeng/tui-core',
      distTarget: '//packages/@overeng/tui-core:dist',
    },
    {
      packageName: '@overeng/tui-react',
      packagePath: 'packages/@overeng/tui-react',
      distTarget: '//packages/@overeng/tui-react:dist',
    },
    {
      packageName: '@overeng/utils',
      packagePath: 'packages/@overeng/utils',
      distTarget: '//packages/@overeng/utils:dist',
    },
    {
      packageName: '@overeng/utils-dev',
      packagePath: 'packages/@overeng/utils-dev',
      distTarget: '//packages/@overeng/utils-dev:dist',
    },
  ],
  authorities: [{ declarationEntrypoint: 'src/mod.d.ts', projectFile: 'tsconfig.json' }],
  tests: [
    {
      name: 'test',
      runner: 'vitest',
      // CLI and holder-client wire contracts use only the pinned Bun. Native
      // Git, Nix, coreutils, flock and PTY fixtures stay in the complete source
      // complement (decision 0026), retained by `test:megarepo` and the explicit
      // `test:megarepo-cold-gc` owner rather than given ambient host tools.
      tools: { BUN_BIN: '//buck2/toolchains:tool_bun' },
      excludes: [
        'src/cli/cli.integration.test.ts',
        'src/cli/pin.integration.test.ts',
        'src/cli/prompt-select-pty.test.ts',
        'src/cli/status.integration.test.ts',
        'src/cli/store-gc-budgets.integration.test.ts',
        'src/cli/store-gc-cold.integration.test.ts',
        'src/cli/store-gc-generated.integration.test.ts',
        'src/cli/store-gc-otel.integration.test.ts',
        // Mount/user-namespace CLI fixture: collected only by the source unbounded complement.
        'src/cli/store-gc-partial-deletion.integration.test.ts',
        'src/cli/store-rehome.integration.test.ts',
        'src/cli/store.integration.test.ts',
        'src/cli/sync.integration.test.ts',
        'src/core/git-common-config.integration.test.ts',
        'src/core/git-memory.integration.test.ts',
        'src/core/git-reflog.integration.test.ts',
        'src/core/git-streaming-parsers.integration.test.ts',
        'src/core/git-timeout.integration.test.ts',
        'src/core/nix-lock/mod.integration.test.ts',
        'src/core/nix-lock/standalone.integration.test.ts',
        'src/store/git-writer-lock.integration.test.ts',
        'src/store/pnpm-store-cache-lease.integration.test.ts',
        'src/store/store-archive.integration.test.ts',
        'src/store/store-branch-worktree.integration.test.ts',
        'src/store/store-buck-maintain-evidence.integration.test.ts',
        'src/store/store-buck-maintain-safety.integration.test.ts',
        'src/store/store-buck-maintain.integration.test.ts',
        'src/store/store-deletion-lease.integration.test.ts',
        'src/store/store-fetch-refspec.integration.test.ts',
        'src/store/store-fetch.integration.test.ts',
        'src/store/store-gc-receipts.integration.test.ts',
        'src/store/store-hygiene.unit.test.ts',
        'src/store/store-inuse.integration.test.ts',
        'src/store/store-liveness.integration.test.ts',
        'src/store/store-lossless.integration.test.ts',
        'src/store/store-pinned-deletion.integration.test.ts',
        'src/store/store-verified-directory-pins.integration.test.ts',
        'src/store/store-pool-buck.integration.test.ts',
        'src/store/store-pool-head-history.integration.test.ts',
        'src/store/store-pool-lock-order.integration.test.ts',
        'src/store/store-pool-roots.integration.test.ts',
        'src/store/store-pool-state.integration.test.ts',
        'src/store/store-pool-warm-epoch.integration.test.ts',
        'src/store/store-rehome.basic.integration.test.ts',
        'src/store/store-rehome.integration.test.ts',
        'src/store/store-workspace-activity.integration.test.ts',
        'src/store/store-worktree-holder-codec.integration.test.ts',
        'src/store/store-worktree-remove.integration.test.ts',
        'src/test-utils/setup.integration.test.ts',
        'src/test-utils/store-setup.integration.test.ts',
      ],
      sourceOwners: {
        'src/cli/store-gc-cold.integration.test.ts': 'test:megarepo-cold-gc',
      },
    },
  ],
} as const satisfies Buck2TypeScriptAdmission

export default withJavaScriptCandidates({
  projection: buck2TypeScriptPackageProjection(buck2TypeScriptAdmission),
  products: javaScriptProductsFor(buck2TypeScriptAdmission.packagePath),
})
