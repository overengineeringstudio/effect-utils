import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const ciWorkflowSource = readFileSync(
  new URL('../../../../../../genie/ci-workflow.ts', import.meta.url),
  'utf8',
)
const generatedWorkflowSource = readFileSync(
  new URL('../../../../../../.github/workflows/ci.yml.genie.ts', import.meta.url),
  'utf8',
)

describe('ci workflow retry helpers', () => {
  it('sources the retry helper from a checked-in shell script', () => {
    expect(ciWorkflowSource).toContain('./ci-scripts/nix-gc-race-retry.sh')
    expect(ciWorkflowSource).toContain('__nix_gc_retry_helper=$(mktemp)')
    expect(ciWorkflowSource).toContain('run_nix_gc_race_retry')
  })
})

describe('ci workflow pnpm cache defaults', () => {
  it('keeps the shared pnpm home workspace-relative', () => {
    expect(ciWorkflowSource).toContain(
      "export const jobLocalPnpmHome = '${{ github.workspace }}/.pnpm-home'",
    )
  })

  it('defaults the split cache helpers to pnpm home instead of pnpm store', () => {
    expect(ciWorkflowSource).toContain("const keyPrefix = opts?.keyPrefix ?? 'pnpm-home'")
    expect(ciWorkflowSource).toContain('const path = opts?.path ?? jobLocalPnpmHome')
  })

  it('keeps the diagnostics summary portable', () => {
    expect(generatedWorkflowSource).toContain('head -n 120 "$markers_file"')
    expect(generatedWorkflowSource).not.toContain('sed -n "1,120p" "$markers_file"')
  })
})
