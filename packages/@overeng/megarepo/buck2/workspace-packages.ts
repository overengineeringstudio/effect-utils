import contentAddressPackage from '../../content-address/package.json.genie.ts'
import contentAddressTsconfig from '../../content-address/tsconfig.json.genie.ts'
import effectDistributedLockPackage from '../../effect-distributed-lock/package.json.genie.ts'
import effectDistributedLockTsconfig from '../../effect-distributed-lock/tsconfig.json.genie.ts'
import effectPathPackage from '../../effect-path/package.json.genie.ts'
import effectPathTsconfig from '../../effect-path/tsconfig.json.genie.ts'
import kdlEffectPackage from '../../kdl-effect/package.json.genie.ts'
import kdlEffectTsconfig from '../../kdl-effect/tsconfig.json.genie.ts'
import kdlPackage from '../../kdl/package.json.genie.ts'
import kdlTsconfig from '../../kdl/tsconfig.json.genie.ts'
import otelContractPackage from '../../otel-contract/package.json.genie.ts'
import otelContractTsconfig from '../../otel-contract/tsconfig.json.genie.ts'
import tuiCorePackage from '../../tui-core/package.json.genie.ts'
import tuiCoreTsconfig from '../../tui-core/tsconfig.json.genie.ts'
import tuiReactPackage from '../../tui-react/package.json.genie.ts'
import tuiReactTsconfig from '../../tui-react/tsconfig.json.genie.ts'
import utilsDevPackage from '../../utils-dev/package.json.genie.ts'
import utilsDevTsconfig from '../../utils-dev/tsconfig.json.genie.ts'
import utilsPackage from '../../utils/package.json.genie.ts'
import utilsTsconfig from '../../utils/tsconfig.json.genie.ts'

/** Paired package and tsconfig Genie facets for workspace packages reachable by the mr graph. */
export const workspacePackages = {
  '@overeng/content-address': {
    packageJson: contentAddressPackage,
    tsconfig: contentAddressTsconfig,
  },
  '@overeng/effect-distributed-lock': {
    packageJson: effectDistributedLockPackage,
    tsconfig: effectDistributedLockTsconfig,
  },
  '@overeng/effect-path': { packageJson: effectPathPackage, tsconfig: effectPathTsconfig },
  '@overeng/kdl-effect': { packageJson: kdlEffectPackage, tsconfig: kdlEffectTsconfig },
  '@overeng/kdl': { packageJson: kdlPackage, tsconfig: kdlTsconfig },
  '@overeng/otel-contract': { packageJson: otelContractPackage, tsconfig: otelContractTsconfig },
  '@overeng/tui-core': { packageJson: tuiCorePackage, tsconfig: tuiCoreTsconfig },
  '@overeng/tui-react': { packageJson: tuiReactPackage, tsconfig: tuiReactTsconfig },
  '@overeng/utils-dev': { packageJson: utilsDevPackage, tsconfig: utilsDevTsconfig },
  '@overeng/utils': { packageJson: utilsPackage, tsconfig: utilsTsconfig },
} as const

/** Canonical package name admitted by the generated mr workspace graph. */
export type WorkspacePackageName = keyof typeof workspacePackages

/** Resolve a dependency specifier against the fail-closed workspace registry. */
export const workspaceName = (specifier: string): WorkspacePackageName | undefined =>
  specifier in workspacePackages ? (specifier as WorkspacePackageName) : undefined
