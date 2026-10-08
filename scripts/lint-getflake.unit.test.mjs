import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inspectGetFlake } from './lint-getflake.mjs'

test('rejects bare-path getFlake negative fixtures', () => {
  for (const fixture of [
    'builtins.getFlake (toString repo)',
    'builtins.getFlake (builtins.toString ./.)',
    'builtins.getFlake (builtins.toPath "/checkout")',
    'builtins.getFlake (builtins.getEnv "PRIVATE_PRODUCTS_REPO")',
    'builtins.getFlake "/checkout"',
    'builtins.getFlake "path:/checkout"',
    'builtins.getFlake ./.',
    'builtins.getFlake repo',
    'builtins.getFlake "$ROOT"',
    'builtins.getFlake "${toString ./.}"',
    'builtins.getFlake "$ROOT/subdir"',
    'builtins.getFlake "checkout"',
    'builtins.getFlake "file:///checkout"',
    'NIX_FLAKE_REF="git+file://$ROOT"; builtins.getFlake "$NIX_FLAKE_REF/subdir"',
    'NIX_FLAKE_REF="$PWD"',
    'NIX_FLAKE_REF="${NIX_FLAKE_REF:-$ROOT}"',
    'NIX_FLAKE_REF="path:/checkout"',
    'TEST_FLAKE_REF="$ROOT"',
    'TEST_FLAKE_REF="path:/checkout"',
    'builtins.getFlake (builtins.getEnv "NIX_FLAKE_REF")',
    'builtins.getFlake "$NIX_FLAKE_REF"',
  ])
    assert.notEqual(inspectGetFlake(fixture).length, 0, fixture)
})

test('accepts Git fetcher references and the Git-valued shared test contract', () => {
  for (const fixture of [
    'builtins.getFlake ("git+file://" + toString repo)',
    'builtins.getFlake (\\"git+file://\\" + toString repo)',
    'builtins.getFlake "git+file://${toString ./.}"',
    'builtins.getFlake "github:owner/repo"',
    'builtins.getFlake "git+https://example.com/repo.git"',
    'NIX_FLAKE_REF="git+file://$ROOT"; builtins.getFlake (builtins.getEnv "NIX_FLAKE_REF")',
    'NIX_FLAKE_REF="git+file://$ROOT"; builtins.getFlake "$NIX_FLAKE_REF"',
    'NIX_FLAKE_REF="git+file://$PWD?shallow=1"',
    'NIX_FLAKE_REF="${NIX_FLAKE_REF:-git+file://$ROOT?shallow=1}"',
    '# documented bad example: builtins.getFlake (toString ./.)',
  ])
    assert.deepEqual(inspectGetFlake(fixture), [], fixture)
})

test('an unsafe assignment still fails when another file establishes a safe contract', () => {
  const contract = new Set(['NIX_FLAKE_REF'])
  assert.notEqual(inspectGetFlake('NIX_FLAKE_REF="path:/checkout"', contract).length, 0)
  assert.deepEqual(
    inspectGetFlake('builtins.getFlake (builtins.getEnv "NIX_FLAKE_REF")', contract),
    [],
  )
})
