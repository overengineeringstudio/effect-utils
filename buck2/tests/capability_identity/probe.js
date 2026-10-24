// Runs under both projected Bun (tool A) and Node (the non-user control).
// The parent PATH contains g1-proof-node -> Node, but hermetic_action must scrub it.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const [mode, output, dependency] = process.argv.slice(2)
if (mode === 'dependency_negative') {
  const result = spawnSync('g1-proof-node', ['--eval', 'process.stdout.write("tool-b-executed")'])
  if (result.error?.code !== 'ENOENT' || result.status === 0 || result.stdout?.length > 0) {
    throw new Error('undeclared tool B was executable through ambient parent PATH')
  }
} else if (mode === 'dependency_positive') {
  if (dependency?.startsWith('/nix/store/') !== true)
    throw new Error('tool B must be explicitly declared by absolute store path')
  const result = spawnSync(dependency, ['--eval', 'process.stdout.write("tool-b-executed")'])
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    result.stdout.toString() !== 'tool-b-executed'
  ) {
    throw new Error('explicitly declared tool B did not execute successfully')
  }
} else if (mode !== 'selected' && mode !== 'unselected') {
  throw new Error(`unknown identity proof mode: ${mode}`)
}
writeFileSync(output, `${mode}:ok\n`)
