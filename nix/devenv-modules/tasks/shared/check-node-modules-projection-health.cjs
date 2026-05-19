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

const collectProjectionEntryPaths = (nodeModulesDir) => {
  const result = []
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    const entryPath = path.join(nodeModulesDir, entry.name)
    if (entry.isDirectory()) {
      for (const childEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        result.push(path.join(entryPath, childEntry.name))
      }
      continue
    }

    result.push(entryPath)
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

const verifyPackageContent = ({ pkg, packageDir, entryPath, failures }) => {
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
    targets.push(...collectRootRuntimeExportTargets(pkg.exports))
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

    if (!targetExistsWithNodeResolution(packageDir, target)) {
      failures.push(`${pkg.name ?? entryPath} -> ${target} (${packageDir})`)
    }
  }
}

const runProjectionHash = () => {
  const hash = crypto.createHash('sha256')
  const appendLine = (line) => {
    hash.update(line)
    hash.update('\n')
  }

  appendLine(`gvs-links-dir ${process.env.PNPM_GVS_LINKS_DIR || ''}`)

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

      let target = ''
      try {
        target = fs.readlinkSync(entryPath)
      } catch {}

      if (fs.existsSync(entryPath)) {
        appendLine(`link ${entryPath} -> ${target}`)
      } else {
        appendLine(`broken-link ${entryPath} -> ${target}`)
      }
    }
  }

  const rootModulesYamlPath = process.env.PNPM_ROOT_MODULES_YAML || 'node_modules/.modules.yaml'
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
      verifyPackageContent({
        pkg,
        packageDir: realPath,
        entryPath,
        failures: packageContentFailures,
      })

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

  for (const failure of dependencyProjectionFailures) {
    console.error(`[pnpm] Missing dependency projection: ${failure}`)
  }
  for (const failure of packageContentFailures) {
    console.error(`[pnpm] Missing package content: ${failure}`)
  }

  if (dependencyProjectionFailures.length > 0 || packageContentFailures.length > 0) {
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
