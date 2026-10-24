import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'

import { maintainAfterMaterializationPublication } from '../../packages/@overeng/buck2-tools/src/materialization-archives.ts'
import {
  parseMaterializationRecipe,
  prepareMaterializationRecipe,
  publishMaterializationRecipe,
  verifyMaterializationRecipe,
} from '../../packages/@overeng/buck2-tools/src/materialization-recipes.ts'

const args = process.argv.slice(2)
const values: Record<string, string> = {}
let lockStdin = false
for (let index = 0; index < args.length; index++) {
  const name = args[index]!
  if (name === '--lock-stdin') {
    if (lockStdin === true) throw new Error('duplicate --lock-stdin')
    lockStdin = true
  } else {
    if (
      ['--operation', '--content-store', '--high-water-bytes', '--recipe-json', '--tree'].includes(
        name,
      ) === false ||
      values[name] !== undefined ||
      args[index + 1] === undefined
    )
      throw new Error(`invalid recipe bridge argument: ${name}`)
    values[name] = args[++index]!
  }
}
const value = (name: string): string =>
  values[name] ??
  (() => {
    throw new Error(`missing ${name}`)
  })()
const operation = value('--operation')
const contentStore = value('--content-store')
if (resolve(contentStore) !== contentStore)
  throw new Error('content store must be canonical absolute path')
const highWaterBytes = Number(value('--high-water-bytes'))
if (Number.isSafeInteger(highWaterBytes) === false || highWaterBytes <= 0)
  throw new Error('invalid high water')
const recipeFile = await open(
  value('--recipe-json'),
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
)
let raw: unknown
try {
  const status = await recipeFile.stat()
  if (
    status.isFile() === false ||
    status.size > 64 * 1024 * 1024 ||
    status.uid !== process.getuid!() ||
    status.nlink !== 1
  )
    throw new Error('unsafe private recipe file')
  raw = JSON.parse(await recipeFile.readFile({ encoding: 'utf8' }))
} finally {
  await recipeFile.close()
}
const recipe = parseMaterializationRecipe(raw)
if (operation === 'prepare') {
  if (lockStdin === true || values['--tree'] !== undefined)
    throw new Error('prepare does not accept lock or tree')
  await prepareMaterializationRecipe({ contentStore, recipe })
} else if (operation === 'publish' || operation === 'verify') {
  if (lockStdin === false) throw new Error('recipe writer requires --lock-stdin')
  if (operation === 'publish') {
    await publishMaterializationRecipe({ contentStore, recipe, tree: value('--tree'), lockFd: 0 })
    await maintainAfterMaterializationPublication({
      contentStore,
      metadata: `${contentStore}.buck-materialization-v1`,
      highWaterBytes,
    })
  } else {
    if (values['--tree'] !== undefined) throw new Error('verify does not accept tree')
    await verifyMaterializationRecipe({ contentStore, recipe, lockFd: 0 })
  }
} else throw new Error(`unknown recipe operation: ${operation}`)
