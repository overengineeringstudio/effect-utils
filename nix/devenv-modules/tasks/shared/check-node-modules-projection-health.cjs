const fs = require('fs')
const path = require('path')
const { builtinModules, createRequire } = require('module')
const crypto = require('crypto')

const mode = process.env.NODE_MODULES_HELPER_MODE || 'health'

const moduleDirs = (process.env.NODE_MODULES_DIRS || '')
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value, index, values) => values.indexOf(value) === index)

const existingModuleDirs = moduleDirs.filter((value) => fs.existsSync(value))

const rootModulesYamlPath = process.env.PNPM_ROOT_MODULES_YAML || 'node_modules/.modules.yaml'
const rootNodeModulesPath = path.resolve(moduleDirs[0] || path.dirname(rootModulesYamlPath))
const rootNodeModulesDir = fs.existsSync(rootNodeModulesPath)
  ? fs.realpathSync(rootNodeModulesPath)
  : rootNodeModulesPath
const rootVirtualStoreDir = path.join(rootNodeModulesDir, '.pnpm')

const isWithin = (parentPath, childPath) => {
  const relativePath = path.relative(parentPath, childPath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  )
}

const isPnpmPackageInstance = (packageDir) =>
  packageDir.includes(`${path.sep}node_modules${path.sep}.pnpm${path.sep}`)

const collectProjectionEntryPaths = (nodeModulesDir) => {
  const result = []
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.pnpm') continue

    const entryPath = path.join(nodeModulesDir, entry.name)
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      for (const childEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        result.push(path.join(entryPath, childEntry.name))
      }
      continue
    }

    result.push(entryPath)
  }
  return result.sort()
}

const collectVirtualStoreDependencyEdgePaths = (virtualStoreDir) => {
  if (!fs.existsSync(virtualStoreDir)) return []

  const result = []
  for (const locatorEntry of fs.readdirSync(virtualStoreDir, { withFileTypes: true })) {
    if (!locatorEntry.isDirectory()) continue

    const locatorNodeModulesDir = path.join(virtualStoreDir, locatorEntry.name, 'node_modules')
    if (!fs.existsSync(locatorNodeModulesDir)) continue

    for (const packageEntryPath of collectProjectionEntryPaths(locatorNodeModulesDir)) {
      const packageEntryStat = fs.lstatSync(packageEntryPath)
      if (packageEntryStat.isSymbolicLink()) {
        result.push(packageEntryPath)
        continue
      }
      if (!packageEntryStat.isDirectory()) continue

      const nestedNodeModulesDir = path.join(packageEntryPath, 'node_modules')
      if (!fs.existsSync(nestedNodeModulesDir)) continue
      for (const dependencyEntryPath of collectProjectionEntryPaths(nestedNodeModulesDir)) {
        if (fs.lstatSync(dependencyEntryPath).isSymbolicLink()) result.push(dependencyEntryPath)
      }
    }
  }

  return result.sort()
}

const collectHealthEntryPaths = (nodeModulesDir) => {
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

const resolveDependencyPackageRoot = ({ requireFromPkg, dependencyName }) => {
  if (
    builtinModules.includes(dependencyName) ||
    builtinModules.includes(dependencyName.replace(/^node:/, ''))
  ) {
    return 'builtin'
  }

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

const collectRootRuntimeExportTargets = (exportsValue) => {
  if (typeof exportsValue === 'string' || Array.isArray(exportsValue)) {
    return collectRuntimeExportTargets(exportsValue)
  }

  if (!exportsValue || typeof exportsValue !== 'object') return []

  if (Object.hasOwn(exportsValue, '.')) {
    return collectRuntimeExportTargets(exportsValue['.'])
  }

  const keys = Object.keys(exportsValue)
  if (keys.some((key) => key.startsWith('.'))) return []

  return collectRuntimeExportTargets(exportsValue)
}

const targetExistsWithNodeResolution = (packageDir, target) => {
  const resolved = path.resolve(packageDir, target)
  if (fs.existsSync(resolved)) return true

  for (const suffix of ['.js', '.json', '.node', '.mjs', '.cjs']) {
    if (fs.existsSync(`${resolved}${suffix}`)) return true
  }

  for (const indexFile of ['index.js', 'index.json', 'index.node', 'index.mjs', 'index.cjs']) {
    if (fs.existsSync(path.join(resolved, indexFile))) return true
  }

  return false
}

const packageTargetIsShipped = ({ includedFiles, target }) => {
  if (!target.startsWith('./')) return false
  if (target.includes('*')) return false

  // npm includes package contents by default when `files` is omitted. An
  // explicit non-empty allowlist is the only case where targets can be
  // classified as outside the published package from manifest data alone.
  if (!Array.isArray(includedFiles) || includedFiles.length === 0) return true

  const relativeTarget = target.slice(2)
  return includedFiles.some(
    (file) => file === relativeTarget || relativeTarget.startsWith(`${file}/`),
  )
}

const verifyPackageContent = ({ pkg, packageDir, entryPath, failures }) => {
  if (!packageDir.includes('/node_modules/.pnpm/')) return

  const includedFiles = Array.isArray(pkg.files)
    ? pkg.files.filter((file) => typeof file === 'string' && !file.startsWith('!'))
    : []
  if (includedFiles.length === 0) return

  // Node gives `exports` precedence over the legacy `main` entry point. Some
  // packages retain a stale `main` after moving their supported entry points
  // behind `exports`, so only validate `main` when it is authoritative.
  if (pkg.exports === undefined && typeof pkg.main === 'string') {
    if (
      packageTargetIsShipped({ includedFiles, target: pkg.main }) &&
      !targetExistsWithNodeResolution(packageDir, pkg.main)
    ) {
      failures.push(`${pkg.name ?? entryPath} -> ${pkg.main} (${packageDir})`)
    }
  }

  if (pkg.exports !== undefined) {
    const shippedExportTargets = collectRootRuntimeExportTargets(pkg.exports).filter((target) =>
      packageTargetIsShipped({ includedFiles, target }),
    )
    if (
      shippedExportTargets.length > 0 &&
      !shippedExportTargets.some((target) => targetExistsWithNodeResolution(packageDir, target))
    ) {
      failures.push(
        `${pkg.name ?? entryPath} -> ${shippedExportTargets.join(' | ')} (${packageDir})`,
      )
    }
  }
}

const runProjectionHash = () => {
  const hash = crypto.createHash('sha256')
  const appendLine = (line) => {
    hash.update(line)
    hash.update('\n')
  }

  const appendSymlinkEvidence = (entryPath) => {
    let target = ''
    try {
      target = fs.readlinkSync(entryPath)
    } catch {}

    appendLine(
      `${fs.existsSync(entryPath) ? 'link' : 'broken-link'} ${entryPath} -> ${target}`,
    )
  }

  const appendPackageContentEvidence = (entryPath) => {
    let packageDir
    try {
      packageDir = fs.realpathSync(entryPath)
    } catch {
      return
    }

    const packageJsonPath = path.join(packageDir, 'package.json')
    if (!fs.existsSync(packageJsonPath)) return
    const packageJsonBytes = fs.readFileSync(packageJsonPath)
    const pkg = JSON.parse(packageJsonBytes.toString('utf8'))
    appendLine(
      `package-json ${entryPath} ${crypto.createHash('sha256').update(packageJsonBytes).digest('hex')}`,
    )

    const includedFiles = Array.isArray(pkg.files) ? pkg.files : undefined
    const runtimeTargets = [pkg.main, ...collectRootRuntimeExportTargets(pkg.exports)]
      .filter((target) => typeof target === 'string')
      .filter((target) => packageTargetIsShipped({ includedFiles, target }))
    for (const target of [...new Set(runtimeTargets)].sort()) {
      appendLine(
        `runtime-target ${entryPath} ${target} ${targetExistsWithNodeResolution(packageDir, target) ? 'present' : 'missing'}`,
      )
    }
  }

  for (const nodeModulesDir of moduleDirs) {
    if (fs.existsSync(nodeModulesDir) && fs.statSync(nodeModulesDir).isDirectory()) {
      appendLine(`dir ${nodeModulesDir}`)
    } else {
      appendLine(`missing ${nodeModulesDir}`)
      continue
    }

    for (const entryPath of collectProjectionEntryPaths(nodeModulesDir)) {
      let stat
      try {
        stat = fs.lstatSync(entryPath)
      } catch {
        continue
      }

      if (!stat.isSymbolicLink()) continue

      appendSymlinkEvidence(entryPath)
      appendPackageContentEvidence(entryPath)
    }
  }

  for (const edgePath of collectVirtualStoreDependencyEdgePaths(rootVirtualStoreDir)) {
    appendSymlinkEvidence(edgePath)
  }

  if (fs.existsSync(rootModulesYamlPath)) {
    appendLine(
      `modules-yaml ${crypto
        .createHash('sha256')
        .update(fs.readFileSync(rootModulesYamlPath))
        .digest('hex')}`,
    )
  } else {
    appendLine('modules-yaml missing')
  }

  process.stdout.write(`${hash.digest('hex')}\n`)
}

const runHealthCheck = () => {
  const dependencyProjectionFailures = []
  const packageIdentityFailures = []
  const packageContentFailures = []

  for (const nodeModulesDir of existingModuleDirs) {
    for (const entryPath of collectHealthEntryPaths(nodeModulesDir)) {
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

      if (isPnpmPackageInstance(realPath) && !isWithin(rootVirtualStoreDir, realPath)) {
        packageIdentityFailures.push(
          `${pkg.name ?? entryPath} -> ${realPath} (expected within ${rootVirtualStoreDir})`,
        )
        continue
      }

      verifyPackageContent({
        pkg,
        packageDir: realPath,
        entryPath,
        failures: packageContentFailures,
      })

      if (!realPath.includes('/node_modules/.pnpm/')) continue

      const requiredDependencyNames = new Set(Object.keys(pkg.dependencies ?? {}))
      const dependencyNames = [
        ...new Set([...requiredDependencyNames, ...Object.keys(pkg.peerDependencies ?? {})]),
      ]
      if (dependencyNames.length === 0) continue

      const requireFromPkg = createRequire(packageJsonPath)
      for (const dependencyName of dependencyNames) {
        const dependencyRoot = resolveDependencyPackageRoot({
          requireFromPkg,
          dependencyName,
        })
        if (dependencyRoot === undefined) {
          if (requiredDependencyNames.has(dependencyName)) {
            dependencyProjectionFailures.push(
              `${pkg.name ?? entryPath} -> ${dependencyName} (from ${nodeModulesDir})`,
            )
          }
          continue
        }

        if (dependencyRoot === 'builtin') continue

        const dependencyRealPath = fs.realpathSync(dependencyRoot)
        if (
          isPnpmPackageInstance(dependencyRealPath) &&
          !isWithin(rootVirtualStoreDir, dependencyRealPath)
        ) {
          packageIdentityFailures.push(
            `${pkg.name ?? entryPath} -> ${dependencyName} -> ${dependencyRealPath} (expected within ${rootVirtualStoreDir})`,
          )
        }
      }
    }
  }

  for (const failure of dependencyProjectionFailures) {
    console.error(`[pnpm] Missing dependency projection: ${failure}`)
  }
  for (const failure of packageIdentityFailures) {
    console.error(`[pnpm] Foreign dependency package instance: ${failure}`)
  }
  for (const failure of packageContentFailures) {
    console.error(`[pnpm] Missing package content: ${failure}`)
  }

  if (
    dependencyProjectionFailures.length > 0 ||
    packageIdentityFailures.length > 0 ||
    packageContentFailures.length > 0
  ) {
    process.exit(1)
  }
}

if (mode === 'projection-hash') {
  runProjectionHash()
} else if (mode === 'health') {
  runHealthCheck()
} else {
  console.error(`[pnpm] Unknown node_modules helper mode: ${mode}`)
  process.exit(1)
}
