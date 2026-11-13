import { mkdirSync } from 'node:fs'

type SwiftCompileCommand = {
  readonly command: readonly string[]
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** Bind both compiler module caches to this action, never to mutable host state. */
export const swiftCompileCommand = ({
  compiler,
  arguments: arguments_,
  environment,
}: {
  readonly compiler: string
  readonly arguments: readonly string[]
  readonly environment: Readonly<Record<string, string | undefined>>
}): SwiftCompileCommand => {
  const scratch = environment.BUCK_SCRATCH_PATH
  if (scratch === undefined || scratch === '') {
    throw new Error('swift compile: BUCK_SCRATCH_PATH is required')
  }
  if (arguments_.some((argument) =>
    argument === '-module-cache-path' || argument.startsWith('-module-cache-path=') ||
    argument.startsWith('-fmodules-cache-path='),
  )) {
    throw new Error('swift compile: module-cache arguments are owned by the action')
  }
  const modules = `${scratch}/modules`
  return {
    command: [compiler, '-module-cache-path', modules, ...arguments_],
    environment: {
      ...environment,
      CLANG_MODULE_CACHE_PATH: modules,
      SWIFT_MODULECACHE_PATH: modules,
    },
  }
}

if (import.meta.main) {
  const [compiler, ...arguments_] = process.argv.slice(2)
  if (compiler === undefined) throw new Error('swift compile: compiler is required')
  const { command, environment } = swiftCompileCommand({ compiler, arguments: arguments_, environment: process.env })
  // Buck declares directory outputs without creating them; swiftc writes into this one.
  const symbolGraph = arguments_.indexOf('-emit-symbol-graph-dir')
  if (symbolGraph !== -1) mkdirSync(arguments_[symbolGraph + 1]!, { recursive: true })
  const result = Bun.spawnSync([...command], { env: environment, stdout: 'inherit', stderr: 'inherit' })
  process.exit(result.exitCode)
}
