// Test-only action glue: resolve declared provider artifacts, never crawl buck-out.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const [manifestPath, output] = process.argv.slice(2)
const { primary, artifacts } = JSON.parse(readFileSync(manifestPath, 'utf8'))
const destinations = new Map()
for (const [artifact, simple, dynamic, role] of artifacts) {
  const crate = dynamic ? readFileSync(dynamic, 'utf8').trim() : simple
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(crate)) throw new Error(`Invalid crate: ${crate}`)
  let name = basename(artifact)
  if (artifact === primary) {
    name = `lib${crate}.rlib`
  } else if (dynamic) {
    // Same provisional-name replacement as Prelude, retaining the hash/extension.
    const suffix = name.slice(name.lastIndexOf('-') + 1)
    if (!name.includes('-')) throw new Error(`Missing Prelude suffix: ${artifact}`)
    name = `lib${crate}-${suffix}`
  }
  if (role === 'link' && !name.endsWith('.rlib')) throw new Error(`Not an rlib: ${artifact}`)
  if (role === 'full' && !/\.(rlib|rmeta)$/.test(name)) throw new Error(`Not full metadata: ${artifact}`)
  if (role === 'proc-macro' && !/\.(so|dylib|dll)$/.test(name)) throw new Error(`Not a host macro: ${artifact}`)
  const previous = destinations.get(name)
  if (previous && resolve(previous) !== resolve(artifact)) {
    throw new Error(`Flat destination collision ${name}: ${previous} != ${artifact}`)
  }
  destinations.set(name, artifact)
}
mkdirSync(output, { recursive: true })
for (const [name, artifact] of [...destinations].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
  copyFileSync(artifact, join(output, name))
}
