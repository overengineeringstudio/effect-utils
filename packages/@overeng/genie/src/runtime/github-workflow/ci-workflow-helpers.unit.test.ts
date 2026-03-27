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
})
