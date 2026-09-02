'use strict'

const fs = require('fs')
const path = require('path')

const isBinProjection = (entryName) => entryName === '.bin'

const shouldDeleteFile = (relativePath) =>
  relativePath === 'node_modules/.modules.yaml' ||
  relativePath.endsWith('/node_modules/.modules.yaml') ||
  relativePath.startsWith('node_modules/.pnpm-workspace-state-') ||
  relativePath.includes('/node_modules/.pnpm-workspace-state-') ||
  relativePath === 'node_modules/.pnpm/lock.yaml' ||
  relativePath.endsWith('/node_modules/.pnpm/lock.yaml')

const normalizePreparedTree = (rootPath) => {
  const root = path.resolve(rootPath)

  const normalize = (dirPath) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name)
      const relativePath = path.relative(root, entryPath)

      // Bin projections are derived state. Remove the complete projection
      // boundary before inspecting its contents so broken symlinks and unknown
      // shim forms cannot survive normalization.
      if (isBinProjection(entry.name)) {
        fs.rmSync(entryPath, { recursive: true, force: true })
        continue
      }

      if (entry.isDirectory()) {
        normalize(entryPath)
        fs.chmodSync(entryPath, 0o755)
      } else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(entryPath)
        if (target.includes('.devenv/pnpm-source-inputs')) {
          throw new Error(
            `prepared workspace retained a transient source-input alias reference: ${relativePath} -> ${target}`,
          )
        }
      } else if (entry.isFile()) {
        if (shouldDeleteFile(relativePath)) {
          fs.rmSync(entryPath, { force: true })
          continue
        }
        const mode = fs.statSync(entryPath).mode
        fs.chmodSync(entryPath, (mode & 0o111) === 0 ? 0o444 : 0o555)
      }
    }
  }

  normalize(root)
  fs.chmodSync(root, 0o755)
}

const scanPreparedTree = (rootPath) => {
  const root = path.resolve(rootPath)
  const violations = []

  const scan = (dirPath) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name)
      if (isBinProjection(entry.name)) {
        violations.push(path.relative(root, entryPath))
        continue
      }
      if (entry.isDirectory()) scan(entryPath)
    }
  }

  scan(root)
  if (violations.length > 0) {
    violations.sort()
    throw new Error(`prepared workspace retained bin projection state: ${violations.join(', ')}`)
  }
}

const main = () => {
  const [, , command, rootPath] = process.argv
  if ((command !== 'normalize' && command !== 'scan') || rootPath === undefined) {
    process.stderr.write('usage: prepared-pnpm-tree.cjs <normalize|scan> <workspace-root>\n')
    process.exitCode = 2
    return
  }

  if (command === 'normalize') normalizePreparedTree(rootPath)
  else scanPreparedTree(rootPath)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

module.exports = { normalizePreparedTree, scanPreparedTree }
