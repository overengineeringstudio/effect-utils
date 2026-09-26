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

// pnpm 12 (pacquet) imports each package file by writing
// `<file>_pacquet-stage_<pid>_<nanos>_<seq>` and renaming it onto `<file>`.
// Darwin copy imports occasionally leave the staged twin behind after the
// rename target already landed. The twin's name embeds a pid and timestamp,
// so a surviving twin turns the fixed-output hash into a per-build lottery.
const pacquetStagePattern = /^(.+)_pacquet-stage_\d+_\d+_\d+$/

// Drop a staged twin only when it is a byte-identical copy of its landed
// target; anything else means the import did not complete and must fail.
const removePacquetStageTwin = (dirPath, entryName, relativePath) => {
  const match = pacquetStagePattern.exec(entryName)
  if (match === null) return false
  const targetPath = path.join(dirPath, match[1])
  const target = fs.lstatSync(targetPath, { throwIfNoEntry: false })
  if (target === undefined || !target.isFile()) {
    throw new Error(`prepared workspace retained a pacquet stage file without its landed target: ${relativePath}`)
  }
  const entryPath = path.join(dirPath, entryName)
  if (!fs.readFileSync(entryPath).equals(fs.readFileSync(targetPath))) {
    throw new Error(`prepared workspace retained a pacquet stage file that differs from its landed target: ${relativePath}`)
  }
  fs.rmSync(entryPath, { force: true })
  return true
}

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
        if (removePacquetStageTwin(dirPath, entry.name, relativePath)) continue
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
  const binViolations = []
  const stageViolations = []

  const scan = (dirPath) => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name)
      if (isBinProjection(entry.name)) {
        binViolations.push(path.relative(root, entryPath))
        continue
      }
      if (pacquetStagePattern.test(entry.name)) {
        stageViolations.push(path.relative(root, entryPath))
        continue
      }
      if (entry.isDirectory()) scan(entryPath)
    }
  }

  scan(root)
  if (binViolations.length > 0) {
    binViolations.sort()
    throw new Error(`prepared workspace retained bin projection state: ${binViolations.join(', ')}`)
  }
  if (stageViolations.length > 0) {
    stageViolations.sort()
    throw new Error(`prepared workspace retained pacquet stage files: ${stageViolations.join(', ')}`)
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
