import { spawnSync } from 'node:child_process'
const result = spawnSync('tsc', ['-p', 'negative/tsconfig.json', '--noEmit', '--pretty', 'false'], {
  encoding: 'utf8',
})
const diagnostics = (result.stdout + result.stderr)
  .split('\n')
  .filter((line) => /error TS\d+:/.test(line))
const expected = [
  { line: 6, code: 2345 },
  { line: 7, code: 2345 },
  { line: 8, code: 2322 },
]
if (
  (result.status !== 1 && result.status !== 2) ||
  diagnostics.length !== expected.length ||
  expected.some(
    ({ line, code }) =>
      !diagnostics.some(
        (diagnostic) =>
          diagnostic.includes(`negative/static-safety.ts(${line},`) &&
          diagnostic.includes(`TS${code}:`),
      ),
  )
) {
  process.stderr.write(result.stdout + result.stderr)
  throw new TypeError(
    `Expected exactly three negative-fixture diagnostics; observed ${diagnostics.length}`,
  )
}
process.stdout.write('Negative fixtures: 3 expected diagnostics (TS2345, TS2345, TS2322)\n')
