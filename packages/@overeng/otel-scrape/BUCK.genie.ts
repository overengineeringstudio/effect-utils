import { readdirSync } from 'node:fs'
import { extname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGenieOutput } from '../genie/src/runtime/core.ts'

const packageRoot = fileURLToPath(new URL('./', import.meta.url))
const regenerationCommand = 'devenv tasks run genie:run'
const reindeerVersion = '2026.05.04.00'

const walk = (relativeDirectory: string): readonly string[] => {
  const files: string[] = []
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true }).toSorted(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink() === true)
        throw new Error(`Refusing Buck input symlink: ${relative}`)
      const path = posix.join(relative, entry.name)
      if (entry.isDirectory() === true) visit(path)
      else if (entry.isFile() === true) files.push(path)
    }
  }
  visit(relativeDirectory)
  return files
}

const librarySources = walk('src')
  .filter((path) => extname(path) === '.rs' && path !== 'src/main.rs')
  .toSorted()
const integrationTestSource = 'tests/cli.rs'
const renderList = (values: readonly string[]): string =>
  values.map((value) => `        ${JSON.stringify(value)},`).join('\n')

const rendered = `# GENERATED FILE - DO NOT EDIT. Edit BUCK.genie.ts and the Reindeer inputs.
# Generator: packages/@overeng/otel-scrape/BUCK.genie.ts
# Reindeer generator: ${reindeerVersion}
# Regenerate: ${regenerationCommand}

load("//packages/@overeng/otel-scrape/buck2:otel_scrape.bzl", "otel_scrape_targets")

otel_scrape_targets(
    platform = "x86_64-linux",
    library_sources = [
${renderList(librarySources)}
    ],
    integration_test_source = ${JSON.stringify(integrationTestSource)},
)
`

export default createGenieOutput({
  data: {
    librarySources,
    integrationTestSource,
    reindeerVersion,
  },
  stringify: () => rendered,
})
