'use strict'

const fs = require('fs')
const path = require('path')

const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin'])

const sortedEntries = (dirPath) =>
  fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))

const pathExists = (filePath) => {
  try {
    fs.lstatSync(filePath)
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

const isDirectory = (dirPath) => {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}

const isWithin = (parentPath, childPath) => {
  const relativePath = path.relative(parentPath, childPath)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== '..' &&
      !path.isAbsolute(relativePath))
  )
}

const reportPath = (root, filePath) =>
  path.relative(root, filePath).split(path.sep).join('/') || '.'

const normalizeCommandName = (name) => {
  if (typeof name !== 'string') return null
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  if (
    unscoped.length === 0 ||
    unscoped === '.' ||
    unscoped === '..' ||
    unscoped.includes('/') ||
    unscoped.includes('\\') ||
    encodeURIComponent(unscoped) !== unscoped
  ) {
    return null
  }
  return unscoped
}

const collectNodeModulesDirs = (workspaceRoot) => {
  const result = []

  const walk = (dirPath) => {
    for (const entry of sortedEntries(dirPath)) {
      if (!entry.isDirectory() || entry.name === '.bin') continue
      const entryPath = path.join(dirPath, entry.name)
      if (entry.name === 'node_modules') result.push(entryPath)
      walk(entryPath)
    }
  }

  walk(workspaceRoot)
  return result.sort((left, right) => left.localeCompare(right))
}

const dependencyPackageRoots = (nodeModulesDir) => {
  const roots = []

  for (const entry of sortedEntries(nodeModulesDir)) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const entryPath = path.join(nodeModulesDir, entry.name)
    if (!isDirectory(entryPath)) continue

    if (entry.name.startsWith('@')) {
      for (const scopedEntry of sortedEntries(entryPath)) {
        if (scopedEntry.name.startsWith('.')) continue
        const scopedPath = path.join(entryPath, scopedEntry.name)
        if (!isDirectory(scopedPath)) continue
        roots.push({
          dependencyName: `${entry.name}/${scopedEntry.name}`,
          packageRoot: scopedPath,
          source: 'dependency',
        })
      }
      continue
    }

    roots.push({
      dependencyName: entry.name,
      packageRoot: entryPath,
      source: 'dependency',
    })
  }

  return roots
}

const packageRootsForNodeModules = (nodeModulesDir) => {
  const packageRoots = []
  const localPackageRoot = path.dirname(nodeModulesDir)
  if (pathExists(path.join(localPackageRoot, 'package.json'))) {
    packageRoots.push({
      dependencyName: null,
      packageRoot: localPackageRoot,
      source: 'package-local',
    })
  }
  packageRoots.push(...dependencyPackageRoots(nodeModulesDir))
  return packageRoots
}

const readManifest = (packageRoot) => {
  const manifestPath = path.join(packageRoot, 'package.json')
  if (!pathExists(manifestPath)) return null
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    return manifest && typeof manifest === 'object' ? manifest : null
  } catch (error) {
    throw new Error(`invalid package manifest ${manifestPath}: ${error.message}`)
  }
}

const declaredBins = (manifest, packageRoot) => {
  const bins = []
  const rejections = []

  const addDeclaredBin = (rawName, rawTarget, declaration) => {
    const name = normalizeCommandName(rawName)
    if (name === null) {
      rejections.push({ declaration, name: String(rawName), reason: 'invalid-command-name' })
      return
    }
    if (typeof rawTarget !== 'string' || rawTarget.length === 0) {
      rejections.push({ declaration, name, reason: 'invalid-target' })
      return
    }
    bins.push({ declaration, name, rawTarget })
  }

  if (typeof manifest.bin === 'string') {
    addDeclaredBin(manifest.name, manifest.bin, 'bin')
  } else if (manifest.bin && typeof manifest.bin === 'object' && !Array.isArray(manifest.bin)) {
    for (const rawName of Object.keys(manifest.bin).sort()) {
      addDeclaredBin(rawName, manifest.bin[rawName], 'bin')
    }
  }

  const binDirectory = manifest.directories && manifest.directories.bin
  if (typeof binDirectory === 'string' && binDirectory.length > 0) {
    const directoryPath = path.resolve(packageRoot, binDirectory)
    const realPackageRoot = fs.realpathSync(packageRoot)
    let validDirectory = isWithin(packageRoot, directoryPath) && isDirectory(directoryPath)
    if (validDirectory) {
      validDirectory = isWithin(realPackageRoot, fs.realpathSync(directoryPath))
    }
    if (!validDirectory) {
      rejections.push({
        declaration: 'directories.bin',
        name: binDirectory,
        reason: 'invalid-bin-directory',
      })
    } else {
      for (const entry of sortedEntries(directoryPath)) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue
        addDeclaredBin(
          entry.name,
          path.relative(packageRoot, path.join(directoryPath, entry.name)),
          'directories.bin',
        )
      }
    }
  }

  return { bins, rejections }
}

const validateTarget = (packageRoot, rawTarget) => {
  const targetPath = path.resolve(packageRoot, rawTarget)
  if (!isWithin(packageRoot, targetPath) || !pathExists(targetPath)) {
    return { reason: 'missing-or-outside-target', targetPath }
  }

  let stat
  try {
    stat = fs.statSync(targetPath)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { reason: 'missing-or-outside-target', targetPath }
    }
    throw error
  }
  if (!stat.isFile()) return { reason: 'target-is-not-file', targetPath }

  const realPackageRoot = fs.realpathSync(packageRoot)
  const realTargetPath = fs.realpathSync(targetPath)
  if (!isWithin(realPackageRoot, realTargetPath)) {
    return { reason: 'missing-or-outside-target', targetPath }
  }

  return { targetPath }
}

const projectNodeModulesBins = ({ nodeModulesDir, platform, report, workspaceRoot }) => {
  const binDir = path.join(nodeModulesDir, '.bin')
  const repaired = pathExists(binDir)
  fs.rmSync(binDir, { recursive: true, force: true })

  const selected = new Map()
  for (const packageRecord of packageRootsForNodeModules(nodeModulesDir)) {
    const manifest = readManifest(packageRecord.packageRoot)
    if (manifest === null) continue
    const packageName =
      typeof manifest.name === 'string' ? manifest.name : packageRecord.dependencyName
    const declared = declaredBins(manifest, packageRecord.packageRoot)

    for (const rejection of declared.rejections) {
      report.rejections.push({
        ...rejection,
        dependencyName: packageRecord.dependencyName,
        packageName,
        packageRoot: reportPath(workspaceRoot, packageRecord.packageRoot),
      })
    }

    for (const bin of declared.bins) {
      const target = validateTarget(packageRecord.packageRoot, bin.rawTarget)
      if (target.reason !== undefined) {
        report.rejections.push({
          declaration: bin.declaration,
          dependencyName: packageRecord.dependencyName,
          name: bin.name,
          packageName,
          packageRoot: reportPath(workspaceRoot, packageRecord.packageRoot),
          reason: target.reason,
          target: reportPath(workspaceRoot, target.targetPath),
        })
        continue
      }

      if (selected.has(bin.name)) {
        const winner = selected.get(bin.name)
        report.rejections.push({
          declaration: bin.declaration,
          dependencyName: packageRecord.dependencyName,
          name: bin.name,
          packageName,
          packageRoot: reportPath(workspaceRoot, packageRecord.packageRoot),
          reason: 'command-conflict',
          winnerPackageName: winner.packageName,
        })
        continue
      }

      selected.set(bin.name, {
        declaration: bin.declaration,
        dependencyName: packageRecord.dependencyName,
        name: bin.name,
        packageName,
        source: packageRecord.source,
        targetPath: target.targetPath,
      })
    }
  }

  if (selected.size === 0) return
  fs.mkdirSync(binDir, { recursive: true, mode: 0o755 })

  for (const bin of [...selected.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const linkPath = path.join(binDir, bin.name)
    const relativeTarget = path.relative(binDir, bin.targetPath)
    fs.symlinkSync(relativeTarget, linkPath, 'file')
    report.entries.push({
      declaration: bin.declaration,
      dependencyName: bin.dependencyName,
      link: reportPath(workspaceRoot, linkPath),
      name: bin.name,
      packageName: bin.packageName,
      platform,
      source: bin.source,
      status: repaired ? 'repaired' : 'created',
      target: reportPath(workspaceRoot, bin.targetPath),
    })
  }
}

const projectBins = (workspaceRootPath, options = {}) => {
  const workspaceRoot = path.resolve(workspaceRootPath)
  const platform = options.platform || process.platform
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`unsupported bin projection platform: ${platform}`)
  }

  const report = {
    schema: 'dependency-projection-report/v0',
    profileId: options.profileId || 'prepared-workspace',
    projection: 'bin',
    policy: 'pure-manifest',
    entries: [],
    rejections: [],
  }

  for (const nodeModulesDir of collectNodeModulesDirs(workspaceRoot)) {
    projectNodeModulesBins({ nodeModulesDir, platform, report, workspaceRoot })
  }

  report.entries.sort((left, right) => left.link.localeCompare(right.link))
  report.rejections.sort((left, right) =>
    `${left.packageRoot}:${left.name}:${left.reason}`.localeCompare(
      `${right.packageRoot}:${right.name}:${right.reason}`,
    ),
  )
  return report
}

const main = () => {
  const args = process.argv.slice(2)
  let platform
  if (args[0] === '--platform') {
    platform = args[1]
    args.splice(0, 2)
  }
  if (args.length !== 1) {
    process.stderr.write(
      'usage: pnpm-bin-projector.cjs [--platform linux|darwin] <workspace-root>\n',
    )
    process.exitCode = 2
    return
  }

  const report = projectBins(args[0], {
    platform,
    profileId: process.env.PNPM_BIN_PROJECTION_PROFILE_ID,
  })
  process.stdout.write(`workspace-bin-projector: ${JSON.stringify(report)}\n`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

module.exports = { normalizeCommandName, projectBins }
