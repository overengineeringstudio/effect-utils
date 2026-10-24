import { writeFile } from 'node:fs/promises'

import { acquireSharedArchive } from '../../packages/@overeng/buck2-tools/src/materialization-archives.ts'

const args = process.argv.slice(2)
const value = (name: string): string => {
  const index = args.indexOf(name)
  if (index === -1 || args[index + 1] === undefined) throw new Error(`missing ${name}`)
  return args[index + 1]!
}
const receipt = await acquireSharedArchive({
  contentStore: value('--content-store'),
  highWaterBytes: Number(value('--high-water-bytes')),
  url: value('--url'),
  digest: value('--sha256'),
  size: Number(value('--size')),
  output: value('--output'),
})
process.stderr.write(`[buck-materialization-archive] ${JSON.stringify(receipt)}\n`)

await writeFile(value('--receipt'), `${JSON.stringify(receipt)}\n`, { flag: 'wx', mode: 0o600 })
