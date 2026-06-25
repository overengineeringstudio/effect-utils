import { builtinModules } from 'node:module'
import { createRequire } from 'node:module'
import path from 'node:path'

type SmokeEntry = {
  readonly name: string
  readonly entry: string
}

const builtinSpecifiers = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
])

const nativePtySpecifiers = new Set(['node-pty', '@homebridge/node-pty-prebuilt-multiarch'])

type RollupExternal = (id: string) => boolean

const external: RollupExternal = (id) => {
  if (builtinSpecifiers.has(id)) return true
  if (nativePtySpecifiers.has(id)) return true
  return id.endsWith('.node')
}

const smokeEntries: ReadonlyArray<SmokeEntry> = [
  {
    name: 'pty-effect',
    entry: 'packages/@overeng/pty-effect/src/mod.ts',
  },
  {
    name: 'pty-effect-client',
    entry: 'packages/@overeng/pty-effect/src/client.ts',
  },
]

const repoRoot = path.resolve(process.cwd(), '..', '..', '..')
const ptyEffectRequire = createRequire(
  path.join(repoRoot, 'packages', '@overeng', 'pty-effect', 'package.json'),
)

const main = async () => {
  const { build } = await import(ptyEffectRequire.resolve('vite'))

  for (const smokeEntry of smokeEntries) {
    console.log(`bundle smoke: ${smokeEntry.name}`)
    await build({
      root: repoRoot,
      configFile: false,
      logLevel: 'warn',
      ssr: {
        noExternal: true,
      },
      build: {
        emptyOutDir: false,
        minify: false,
        outDir: path.join(repoRoot, 'tmp', 'bundle-smoke', smokeEntry.name),
        ssr: path.join(repoRoot, smokeEntry.entry),
        write: false,
        rollupOptions: {
          external,
          output: {
            entryFileNames: `${smokeEntry.name}.mjs`,
          },
        },
      },
    })
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
