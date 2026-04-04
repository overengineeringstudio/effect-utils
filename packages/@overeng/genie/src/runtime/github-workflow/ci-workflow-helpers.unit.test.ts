import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  coldFreshNixBuildStep,
  jobLocalPnpmHome,
  restorePnpmStoreStep,
  savePnpmStoreStep,
} from '../../../../../../genie/ci-workflow.ts'

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
    expect(jobLocalPnpmHome).toBe('${{ github.workspace }}/.pnpm-home')
  })

  it('defaults the split cache helpers to pnpm home instead of pnpm store', () => {
    expect(restorePnpmStoreStep().with.path).toBe(jobLocalPnpmHome)
    expect(savePnpmStoreStep().with.path).toBe(jobLocalPnpmHome)
  })

  it('rebuild-checks pnpm deps artifacts instead of deleting shared-store outputs', () => {
    const run = coldFreshNixBuildStep({ flakeRef: '.#pkg' }).run
    expect(run).toContain('installable="${drv}^*"')
    expect(run).toContain(
      'nix build --no-link "$installable" --option substituters "https://cache.nixos.org"',
    )
    expect(run).toContain(
      'nix build --no-link --rebuild "$installable" --option substituters "https://cache.nixos.org"',
    )
    expect(run).not.toContain('nix store delete --ignore-liveness "$outPath"')
  })

  it('prefers explicit depsBuildEntries metadata before falling back to closure scanning', () => {
    const run = coldFreshNixBuildStep({ flakeRef: '.#pkg' }).run
    expect(run).toContain('$targetRef.passthru.depsBuildEntries')
    expect(run).toContain('(.drvPath // "")')
    expect(run).toContain('grep "pnpm-deps-[a-z0-9-]*-v[0-9].*\\.drv$"')
  })

  it('keeps the diagnostics summary portable', () => {
    expect(generatedWorkflowSource).toContain('head -n 120 "$markers_file"')
    expect(generatedWorkflowSource).not.toContain('sed -n "1,120p" "$markers_file"')
  })
})
