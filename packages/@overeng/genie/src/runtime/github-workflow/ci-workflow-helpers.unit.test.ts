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
    expect(ciWorkflowSource).toContain('Failed to convert config\\\\.cachix to JSON')
    expect(ciWorkflowSource).toContain("grep -q 'while evaluating the option'")
    expect(ciWorkflowSource).toContain("grep -q 'cachix\\\\.package'")
    expect(ciWorkflowSource).toContain(
      'Nix store validity race detected for $__task via cachix eval wrapper',
    )
  })

  it('keeps the cachix wrapper matcher shell-safe', () => {
    expect(ciWorkflowSource).not.toContain(
      'grep -q "while evaluating the option \\`cachix\\\\.package\'"',
    )
  })

  it('avoids non-portable perl and grep -P usage in the retry helper', () => {
    expect(ciWorkflowSource).not.toContain('perl -0pe')
    expect(ciWorkflowSource).not.toContain('grep -oP')
    expect(ciWorkflowSource).toContain("tr '\\n' ' ' < \"$__log\"")
    expect(ciWorkflowSource).toContain('sed -n "s#.*error:[[:space:]]*path')
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
