import { createHash } from 'node:crypto'
import { chmod, open, readFile, stat, writeFile } from 'node:fs/promises'

export type CargoResourceErrorCode =
  | 'InvalidManifest'
  | 'InvalidSource'
  | 'DigestMismatch'
  | 'OutputFailure'

export class CargoResourceInventoryError extends Error {
  readonly _tag = 'CargoResourceInventoryError'

  constructor(
    readonly code: CargoResourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CargoResourceInventoryError'
  }
}

type Resource = {
  key: string
  source: string
  destination: string
  expectedDigest?: string
}

const invalid = (message: string): never => {
  throw new CargoResourceInventoryError('InvalidManifest', message)
}

const decodeResources = (value: unknown): Resource[] => {
  if (Array.isArray(value) === false) return invalid('Resource manifest must be an array')
  const keys = new Set<string>()
  const destinations = new Set<string>()
  const resources = value.map((entry: unknown): Resource => {
    if (typeof entry !== 'object' || entry === null)
      return invalid('Resource entry must be an object')
    if (
      !('key' in entry) ||
      typeof entry.key !== 'string' ||
      /^file-(0|[1-9][0-9]*)$/.test(entry.key) === false
    ) {
      return invalid('Resource key must have the form file-N')
    }
    if (keys.has(entry.key) === true) return invalid(`Duplicate resource key: ${entry.key}`)
    keys.add(entry.key)
    if (!('source' in entry) || typeof entry.source !== 'string' || entry.source.length === 0) {
      return invalid(`Missing source for ${entry.key}`)
    }
    if (!('destination' in entry) || typeof entry.destination !== 'string') {
      return invalid(`Missing destination for ${entry.key}`)
    }
    const destination = entry.destination
    if (
      // oxlint-disable-next-line no-control-regex -- Resource destinations reject ASCII controls.
      /[\\:\u0000-\u001f\u007f]/.test(destination) === true ||
      destination.split('/').some((part) => part === '' || part === '.' || part === '..') === true
    ) {
      return invalid(`Destination must be a normalized repository-relative path: ${destination}`)
    }
    if (destinations.has(destination) === true)
      return invalid(`Duplicate resource destination: ${destination}`)
    destinations.add(destination)
    const expectedDigest = 'expectedDigest' in entry ? entry.expectedDigest : undefined
    if (
      expectedDigest !== undefined &&
      expectedDigest !== null &&
      (typeof expectedDigest !== 'string' || /^[0-9a-f]{64}$/.test(expectedDigest) === false)
    ) {
      return invalid(`Invalid SHA256 for ${entry.key}`)
    }
    return {
      key: entry.key,
      source: entry.source,
      destination,
      expectedDigest: expectedDigest ?? undefined,
    }
  })
  for (const destination of destinations) {
    const parts = destination.split('/')
    for (let length = 1; length < parts.length; length++) {
      const prefix = parts.slice(0, length).join('/')
      if (destinations.has(prefix) === true)
        return invalid(`Resource destination prefix collision: ${prefix} and ${destination}`)
    }
  }
  return resources.sort((left, right) =>
    left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0,
  )
}

/** Copies exactly the bytes hashed, never reopening a source after validation. */
export const writeCargoResourceInventory = async (
  manifest: unknown,
  inventoryPath: string,
  outputs: ReadonlyMap<string, string>,
): Promise<void> => {
  const resources = decodeResources(manifest)
  if (
    outputs.size !== resources.length ||
    resources.some(({ key }) => outputs.has(key) === false) === true
  ) {
    return invalid('Output keys must exactly match resource keys')
  }
  const outputPaths = new Set(outputs.values())
  if (outputPaths.size !== outputs.size || outputPaths.has(inventoryPath) === true) {
    return invalid('Resource and inventory outputs must have distinct paths')
  }
  const verified = []
  for (const resource of resources) {
    let bytes: Buffer
    let mode: number
    try {
      if ((await stat(resource.source)).isFile() === false) {
        throw new CargoResourceInventoryError(
          'InvalidSource',
          `Resource ${resource.key} is not a file: ${resource.source}`,
        )
      }
      const handle = await open(resource.source, 'r')
      try {
        const sourceStat = await handle.stat()
        if (sourceStat.isFile() === false) {
          throw new CargoResourceInventoryError(
            'InvalidSource',
            `Resource ${resource.key} is not a file: ${resource.source}`,
          )
        }
        bytes = await handle.readFile()
        mode = (sourceStat.mode & 0o111) === 0 ? 0o644 : 0o755
      } finally {
        await handle.close()
      }
    } catch (cause) {
      if (cause instanceof CargoResourceInventoryError) throw cause
      throw new CargoResourceInventoryError(
        'InvalidSource',
        `Cannot read resource ${resource.key}: ${resource.source}`,
        { cause },
      )
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (resource.expectedDigest !== undefined && resource.expectedDigest !== sha256) {
      throw new CargoResourceInventoryError(
        'DigestMismatch',
        `SHA256 mismatch for ${resource.key} (${resource.destination}): expected ${resource.expectedDigest}, actual ${sha256}`,
      )
    }
    verified.push({ resource, bytes, sha256, mode })
  }
  try {
    for (const { resource, bytes, mode } of verified) {
      const output = outputs.get(resource.key)
      if (output === undefined) return invalid(`Missing output for ${resource.key}`)
      await writeFile(output, bytes)
      await chmod(output, mode)
    }
    await writeFile(
      inventoryPath,
      `${JSON.stringify(
        verified.map(({ resource, sha256, mode }) => ({
          destination: resource.destination,
          sha256,
          mode,
        })),
        null,
        2,
      )}\n`,
    )
  } catch (cause) {
    if (cause instanceof CargoResourceInventoryError) throw cause
    throw new CargoResourceInventoryError(
      'OutputFailure',
      'Cannot write verified Cargo resource outputs',
      { cause },
    )
  }
}

if (import.meta.main) {
  const [manifestPath, inventoryPath, ...outputArgs] = process.argv.slice(2)
  if (manifestPath === undefined || inventoryPath === undefined || outputArgs.length % 2 !== 0) {
    invalid('Usage: cargo-resource-inventory.ts MANIFEST INVENTORY [file-N OUTPUT ...]')
  }
  const outputs = new Map<string, string>()
  for (let index = 0; index < outputArgs.length; index += 2) {
    const key = outputArgs[index]
    const output = outputArgs[index + 1]
    if (key === undefined || output === undefined || outputs.has(key) === true)
      invalid('Malformed or duplicate output argument')
    outputs.set(key, output)
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (cause) {
    throw new CargoResourceInventoryError(
      'InvalidManifest',
      `Cannot read resource manifest: ${manifestPath}`,
      { cause },
    )
  }
  await writeCargoResourceInventory(manifest, inventoryPath, outputs)
}
