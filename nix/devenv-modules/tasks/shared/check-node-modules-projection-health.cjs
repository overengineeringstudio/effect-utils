const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')
const crypto = require('crypto')

const mode = process.env.NODE_MODULES_HELPER_MODE || 'health'

/**
 * Keep the node_modules helper logic in one process so the warm status path
 * can preserve its exact structural fingerprint semantics without paying for
 * hundreds of shell-level `readlink` subprocesses.
 */
const moduleDirs = (process.env.NODE_MODULES_DIRS || '')
  .split('\n')
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value, index, values) => values.indexOf(value) === index)
  .filter((value) => fs.existsSync(value))

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

const runProjectionHash = () => {
  const hash = crypto.createHash('sha256')
  const appendLine = (line) => {
    hash.update(line)
    hash.update('\n')
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
  for (const nodeModulesDir of moduleDirs) {
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
}

if (mode === 'projection-hash') {
  runProjectionHash()
} else if (mode === 'health') {
  runHealthCheck()
} else {
  console.error(`[pnpm] Unknown node_modules helper mode: ${mode}`)
  process.exit(1)
}
