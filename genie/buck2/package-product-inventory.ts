export interface PublishedPackageManifest {
  readonly name: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

/** Every install-time workspace edge must have an artifact in the same cache inventory. */
export const assertPublishedPackageClosure = ({
  packages,
  workspaceNames,
}: {
  readonly packages: readonly PublishedPackageManifest[]
  readonly workspaceNames: ReadonlySet<string>
}): void => {
  const publishedNames = new Set(packages.map((pkg) => pkg.name))
  for (const pkg of packages) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (workspaceNames.has(name) === true && publishedNames.has(name) === false) {
          throw new Error(
            `Published package ${pkg.name} has ${field} on unpublished workspace package ${name}; add its package product to the cache inventory`,
          )
        }
      }
    }
  }
}
