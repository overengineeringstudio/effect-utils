const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = fs.realpathSync(process.cwd())
const stage = path.join(root, '.devenv/pnpm-source-inputs')
const current = path.join(stage, 'current')
assert.ok(fs.lstatSync(current).isSymbolicLink(), 'staging current must be a symlink')
const generation = fs.realpathSync(current)
assert.ok(generation.startsWith(path.join(stage, 'generations') + path.sep))
const source = 'repos/source/packages/shared'
for (const file of ['package.json', 'index.cjs']) {
  assert.deepEqual(
    fs.readFileSync(path.join(current, source, file)),
    fs.readFileSync(path.join(root, source, file)),
  )
}
const installed = fs.realpathSync(require.resolve('@fixture/shared'))
assert.ok(
  installed.startsWith(path.join(root, 'node_modules') + path.sep),
  'package must be installed, not resolved from source',
)
assert.equal(require('@fixture/shared'), 'consumer-smoke-staged-source-ok')
console.log('consumer-smoke: real pnpm install, source staging, and installed sentinel passed')
