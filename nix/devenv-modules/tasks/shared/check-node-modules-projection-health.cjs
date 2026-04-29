const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

/**
 * GVS can leave package symlinks present while still dropping transitive
 * projections after config/path changes. Checking only for broken symlinks
 * misses that failure mode, so this helper resolves each symlinked package's
 * declared runtime deps from the package's real path.
 */
const moduleDirs = (process.env.NODE_MODULES_DIRS || '')
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value, index, values) => values.indexOf(value) === index)
  .filter((value) => fs.existsSync(value))

const dependencyProjectionFailures = []
const packageContentFailures = []

const collectEntryPaths = (nodeModulesDir) => {
  const result = []
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue

    const entryPath = path.join(nodeModulesDir, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        result.push(path.join(entryPath, scopedEntry.name))
      }
      continue
    }

    result.push(entryPath)
  }
  return result
}

/**
 * `require.resolve("${dependencyName}/package.json")` is not a valid health
 * check because many packages intentionally do not export that subpath. We
 * need to verify the projected package directory itself is reachable via Node's
 * package search paths, independent of its public exports surface.
 */
const resolveDependencyPackageRoot = ({ requireFromPkg, dependencyName }) => {
  const packagePath = dependencyName.split('/')
  const searchPaths = requireFromPkg.resolve.paths(dependencyName) ?? []

  for (const searchPath of searchPaths) {
    const dependencyRoot = path.join(searchPath, ...packagePath)
    if (fs.existsSync(path.join(dependencyRoot, 'package.json'))) {
      return dependencyRoot
    }
  }

  return undefined
}

const isDeclarationTarget = (value) =>
  value.endsWith('.d.ts') || value.endsWith('.d.mts') || value.endsWith('.d.cts')

/**
 * Only runtime export targets prove whether the package projection can be
 * loaded. Declaration-only branches are intentionally ignored: several packages
 * publish type conditions that are absent from the GVS link projection while
 * their runtime `default` / `import` targets are present and load correctly.
 * See https://github.com/pnpm/pnpm/issues/11385 for the stale runtime-export
 * projection scenario this check guards.
 */
const collectRuntimeExportTargets = (value, conditionName = undefined) => {
  if (typeof value === 'string') {
    if (conditionName === 'types' || isDeclarationTarget(value)) return []
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectRuntimeExportTargets(entry, conditionName))
  }

  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([nestedConditionName, nestedValue]) =>
      collectRuntimeExportTargets(nestedValue, nestedConditionName),
    )
  }

  return []
}

const verifyPackageContent = ({ pkg, packageDir, entryPath }) => {
  if (!packageDir.includes('/v11/links/')) return

  const includedFiles = Array.isArray(pkg.files)
    ? pkg.files.filter((file) => typeof file === 'string' && !file.startsWith('!'))
    : []
  if (includedFiles.length === 0) return

  const targets = []

  if (typeof pkg.main === 'string') {
    targets.push(pkg.main)
  }

  if (pkg.exports !== undefined) {
    targets.push(...collectRuntimeExportTargets(pkg.exports))
  }

  for (const target of targets) {
    if (!target.startsWith('./')) continue
    if (target.includes('*')) continue

    const relativeTarget = target.slice(2)
    if (
      !includedFiles.some(
        (file) => file === relativeTarget || relativeTarget.startsWith(`${file}/`),
      )
    ) {
      continue
    }

    const resolved = path.resolve(packageDir, target)
    if (!fs.existsSync(resolved)) {
      packageContentFailures.push(`${pkg.name ?? entryPath} -> ${target} (${packageDir})`)
    }
  }
}

for (const nodeModulesDir of moduleDirs) {
  for (const entryPath of collectEntryPaths(nodeModulesDir)) {
    let stat
    try {
      stat = fs.lstatSync(entryPath)
    } catch {
      continue
    }

    if (!stat.isSymbolicLink()) continue

    let realPath
    try {
      realPath = fs.realpathSync(entryPath)
    } catch {
      continue
    }

    const packageJsonPath = path.join(realPath, 'package.json')
    if (!fs.existsSync(packageJsonPath)) continue

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    verifyPackageContent({ pkg, packageDir: realPath, entryPath })

    const dependencyNames = Object.keys(pkg.dependencies ?? {})
    if (dependencyNames.length === 0) continue

    const requireFromPkg = createRequire(packageJsonPath)
    for (const dependencyName of dependencyNames) {
      if (
        resolveDependencyPackageRoot({
          requireFromPkg,
          dependencyName,
        }) === undefined
      ) {
        dependencyProjectionFailures.push(
          `${pkg.name ?? entryPath} -> ${dependencyName} (from ${nodeModulesDir})`,
        )
      }
    }
  }
}

if (dependencyProjectionFailures.length > 0) {
  for (const failure of dependencyProjectionFailures) {
    console.error(`[pnpm] Missing dependency projection: ${failure}`)
  }
  process.exit(1)
}

if (packageContentFailures.length > 0) {
  for (const failure of packageContentFailures) {
    console.error(`[pnpm] Missing package content: ${failure}`)
  }
  process.exit(1)
}
