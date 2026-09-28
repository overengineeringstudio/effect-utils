'use strict'

const fs = require('fs')
const path = require('path')

const lockfilePath = process.argv[2]
if (lockfilePath === undefined) {
  process.stderr.write('usage: absent-pnpm-lock-importers.cjs <pnpm-lock.yaml>\n')
  process.exitCode = 2
} else {
  const lockfileDir = path.dirname(path.resolve(lockfilePath))
  const importers = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (!Array.isArray(importers) || importers.some((importer) => typeof importer !== 'string')) {
    throw new Error('pnpm lockfile importers must be a string array')
  }

  for (const importer of importers) {
    const importerDir = path.resolve(lockfileDir, importer)
    const relativeImporterDir = path.relative(lockfileDir, importerDir)
    if (
      path.isAbsolute(importer) ||
      relativeImporterDir === '..' ||
      relativeImporterDir.startsWith(`..${path.sep}`)
    ) {
      throw new Error(`pnpm lockfile importer escapes its install root: ${importer}`)
    }
    if (!fs.existsSync(path.join(importerDir, 'package.json'))) {
      process.stdout.write(`${importer}\n`)
    }
  }
}
