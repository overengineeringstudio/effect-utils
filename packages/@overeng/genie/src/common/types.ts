/** Resolved package info from a workspace package.json */
export type PackageInfo = {
  name: string
  path: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  pnpm?: { patchedDependencies?: Record<string, string> }
}
