import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const ciWorkflowSource = readFileSync(
  new URL('../../../../../../genie/ci-workflow.ts', import.meta.url),
  'utf8',
)

describe('ci workflow retry helpers', () => {
  it('captures stdout and stderr when scanning for Nix store validity races', () => {
    expect(ciWorkflowSource).toContain('eval "$1" > >(tee -a "$__log") 2> >(tee -a "$__log" >&2)')
  })

  it('recognizes cachix evaluation wrappers as the same invalid-store-path failure class', () => {
    expect(ciWorkflowSource).toContain('*"Failed to convert config.cachix to JSON"*)')
    expect(ciWorkflowSource).toContain('*"while evaluating the option"*cachix.package*)')
    expect(ciWorkflowSource).toContain(
      'Nix store validity race detected for $__task via cachix eval wrapper',
    )
  })

  it('does not require grep in the retry helper', () => {
    expect(ciWorkflowSource).not.toContain("grep -q 'Failed to convert config\\\\.cachix to JSON'")
    expect(ciWorkflowSource).not.toContain("grep -q 'while evaluating the option'")
    expect(ciWorkflowSource).not.toContain('grep -aoE "path \'/nix/store/')
  })

  it('keeps the cachix wrapper matcher shell-safe', () => {
    expect(ciWorkflowSource).not.toContain(
      'grep -q "while evaluating the option \\`cachix\\\\.package\'"',
    )
  })

  it('retries cachix wrapper failures even when the invalid store path was not extracted', () => {
    expect(ciWorkflowSource).toContain(
      'if [ "$__saw_invalid_path" != true ] && [ "$__saw_cachix_signature" != true ]; then',
    )
    expect(ciWorkflowSource).toContain('via cachix eval wrapper without extracted store path')
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
})
