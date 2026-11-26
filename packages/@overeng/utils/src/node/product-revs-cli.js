#!/usr/bin/env node
// Checked JavaScript entry point: consumers run it with plain Node from a linked workspace package.
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { manifestSourcePaths, syncProductRevs } from './product-revs.js'

const usage =
  'Usage: product-revs-cli.js <refresh|check> --product NAME --manifest PACKAGE_JSON --output FILE [--input PATH]... [--root DIR]'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: 'string', default: '.' },
    product: { type: 'string' },
    manifest: { type: 'string' },
    output: { type: 'string' },
    input: { type: 'string', multiple: true, default: [] },
  },
})
const [mode] = positionals
if (
  (mode !== 'refresh' && mode !== 'check') ||
  values.product === undefined ||
  values.manifest === undefined ||
  values.output === undefined
) {
  console.error(usage)
  process.exit(2)
}
const root = resolve(values.root)
try {
  const sourcePaths = await manifestSourcePaths({
    manifest: resolve(root, values.manifest),
    inputs: values.input,
  })
  const messages = await syncProductRevs({
    root,
    mode,
    products: [{ product: values.product, sourcePaths, output: values.output }],
  })
  if (mode === 'check' && messages.length > 0) {
    for (const message of messages) console.error(message)
    console.error(
      'Commit closure sources first, then run the refresh task and commit the result as "refresh product revs".',
    )
    process.exit(1)
  }
  for (const message of messages) console.log(message)
  if (messages.length === 0) console.log(`${values.product}: ${values.output} is fresh`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
