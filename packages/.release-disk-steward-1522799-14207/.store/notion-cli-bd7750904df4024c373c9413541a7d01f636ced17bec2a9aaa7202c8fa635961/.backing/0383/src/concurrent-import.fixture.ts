/**
 * Reproduction fixture for #787: the umbrella `notion` binary loads its three
 * command trees concurrently via `Promise.all` (see `cli.ts`'s `runRootCli`).
 *
 * Under Bun's concurrent async module evaluation this used to reach a renderer
 * `app.ts`'s top-level `createTuiApp(...)` side-effect while the shared
 * `@overeng/tui-react` module graph was still mid-initialization, producing a
 * TDZ `ReferenceError: Cannot access '…' before initialization`.
 *
 * Run with Bun (the umbrella binary's runtime). Exits non-zero on the crash.
 */
const main = async () => {
  await Promise.all([
    import('@overeng/notion-md/cli-program'),
    import('./commands/db/mod.ts'),
    import('./commands/schema/mod.ts'),
  ])
  process.stdout.write('CONCURRENT_IMPORT_OK\n')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`CONCURRENT_IMPORT_CRASH: ${message}\n`)
  process.exit(1)
})
