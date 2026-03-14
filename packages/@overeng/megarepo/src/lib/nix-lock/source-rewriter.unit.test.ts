import { describe, expect, it } from 'vitest'

import {
  rewriteFlakeNixUrls,
  rewriteDevenvYamlUrls,
  rewriteLockFileRefs,
  type SourceUrlUpdate,
} from './source-rewriter.ts'

// =============================================================================
// rewriteFlakeNixUrls
// =============================================================================

describe('rewriteFlakeNixUrls', () => {
  const flakeNixContent = `{
  description = "My project flake";

  inputs = {
    # Main dependency
    effect-utils.url = "github:overengineeringstudio/effect-utils/main";
    effect-utils.flake = true;

    # Another dep with git+https
    playwright.url = "git+https://github.com/nicknisi/playwright-nix?ref=feature/branch&rev=abc123";

    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs, effect-utils, playwright }: {
    # outputs here
  };
}`

  it('should update ref in github: URL', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      [
        'effect-utils',
        { memberName: 'effect-utils', newRef: 'schickling/2026-03-12-pnpm-refactor' },
      ],
    ])
    const result = rewriteFlakeNixUrls({ content: flakeNixContent, updates })
    expect(result.updatedInputs).toEqual(['effect-utils'])
    expect(result.content).toContain(
      'effect-utils.url = "github:overengineeringstudio/effect-utils/schickling/2026-03-12-pnpm-refactor"',
    )
    // Preserve everything else
    expect(result.content).toContain('# Main dependency')
    expect(result.content).toContain('effect-utils.flake = true')
    expect(result.content).toContain('nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"')
  })

  it('should update rev in git+https URL', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['playwright', { memberName: 'playwright', newRev: 'def456' }],
    ])
    const result = rewriteFlakeNixUrls({ content: flakeNixContent, updates })
    expect(result.updatedInputs).toEqual(['playwright'])
    expect(result.content).toContain(
      'playwright.url = "git+https://github.com/nicknisi/playwright-nix?ref=feature/branch&rev=def456"',
    )
  })

  it('should update both ref and rev', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['playwright', { memberName: 'playwright', newRef: 'new-branch', newRev: 'def456' }],
    ])
    const result = rewriteFlakeNixUrls({ content: flakeNixContent, updates })
    expect(result.updatedInputs).toEqual(['playwright'])
    expect(result.content).toContain(
      'playwright.url = "git+https://github.com/nicknisi/playwright-nix?ref=new-branch&rev=def456"',
    )
  })

  it('should preserve formatting and comments', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['effect-utils', { memberName: 'effect-utils', newRef: 'new-branch' }],
    ])
    const result = rewriteFlakeNixUrls({ content: flakeNixContent, updates })
    // Original structure is preserved
    expect(result.content).toContain('description = "My project flake"')
    expect(result.content).toContain('# Main dependency')
    expect(result.content).toContain('# Another dep with git+https')
    expect(result.content).toContain('outputs = { self, nixpkgs, effect-utils, playwright }')
  })

  it('should handle URL with ?dir= param', () => {
    const content = `{
  inputs = {
    my-flake.url = "github:owner/repo/old-ref?dir=nix/my-flake";
  };
}`
    const updates = new Map<string, SourceUrlUpdate>([
      ['my-flake', { memberName: 'my-flake', newRef: 'new-ref' }],
    ])
    const result = rewriteFlakeNixUrls({ content, updates })
    expect(result.updatedInputs).toEqual(['my-flake'])
    expect(result.content).toContain('my-flake.url = "github:owner/repo/new-ref?dir=nix/my-flake"')
  })

  it('should not modify inputs without matching update', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['nonexistent', { memberName: 'nonexistent', newRef: 'whatever' }],
    ])
    const result = rewriteFlakeNixUrls({ content: flakeNixContent, updates })
    expect(result.updatedInputs).toEqual([])
    expect(result.content).toBe(flakeNixContent)
  })

  it('should handle top-level inputs.NAME.url form', () => {
    const content = `{
  inputs.effect-utils.url = "github:overengineeringstudio/effect-utils/main";
  inputs.effect-utils.flake = true;
}`
    const updates = new Map<string, SourceUrlUpdate>([
      ['effect-utils', { memberName: 'effect-utils', newRef: 'develop' }],
    ])
    const result = rewriteFlakeNixUrls({ content, updates })
    expect(result.updatedInputs).toEqual(['effect-utils'])
    expect(result.content).toContain(
      'inputs.effect-utils.url = "github:overengineeringstudio/effect-utils/develop"',
    )
  })

  it('should remove ref when newRef is null', () => {
    const content = `{
  inputs.my-dep.url = "github:owner/repo/some-branch";
}`
    const updates = new Map<string, SourceUrlUpdate>([
      ['my-dep', { memberName: 'my-dep', newRef: null }],
    ])
    const result = rewriteFlakeNixUrls({ content, updates })
    expect(result.updatedInputs).toEqual(['my-dep'])
    expect(result.content).toContain('inputs.my-dep.url = "github:owner/repo"')
  })
})

// =============================================================================
// rewriteDevenvYamlUrls
// =============================================================================

describe('rewriteDevenvYamlUrls', () => {
  const devenvYaml = `# Project devenv config
inputs:
  effect-utils:
    url: github:overengineeringstudio/effect-utils/main
    flake: true
  playwright:
    url: "git+https://github.com/nicknisi/playwright-nix?ref=feature/branch"
  nixpkgs:
    url: github:NixOS/nixpkgs/nixos-unstable

allowUnfree: true
`

  it('should update ref in unquoted URL', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['effect-utils', { memberName: 'effect-utils', newRef: 'new-branch' }],
    ])
    const result = rewriteDevenvYamlUrls({ content: devenvYaml, updates })
    expect(result.updatedInputs).toEqual(['effect-utils'])
    expect(result.content).toContain(
      '    url: github:overengineeringstudio/effect-utils/new-branch',
    )
  })

  it('should update ref in double-quoted URL', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['playwright', { memberName: 'playwright', newRef: 'new-branch' }],
    ])
    const result = rewriteDevenvYamlUrls({ content: devenvYaml, updates })
    expect(result.updatedInputs).toEqual(['playwright'])
    expect(result.content).toContain(
      '    url: "git+https://github.com/nicknisi/playwright-nix?ref=new-branch"',
    )
  })

  it('should update rev in URL', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['playwright', { memberName: 'playwright', newRev: 'abc123' }],
    ])
    const result = rewriteDevenvYamlUrls({ content: devenvYaml, updates })
    expect(result.updatedInputs).toEqual(['playwright'])
    expect(result.content).toContain(
      '    url: "git+https://github.com/nicknisi/playwright-nix?ref=feature/branch&rev=abc123"',
    )
  })

  it('should preserve comments and other keys', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['effect-utils', { memberName: 'effect-utils', newRef: 'new-branch' }],
    ])
    const result = rewriteDevenvYamlUrls({ content: devenvYaml, updates })
    expect(result.content).toContain('# Project devenv config')
    expect(result.content).toContain('    flake: true')
    expect(result.content).toContain('allowUnfree: true')
    expect(result.content).toContain('    url: github:NixOS/nixpkgs/nixos-unstable')
  })

  it('should not modify inputs without matching update', () => {
    const updates = new Map<string, SourceUrlUpdate>([
      ['nonexistent', { memberName: 'nonexistent', newRef: 'whatever' }],
    ])
    const result = rewriteDevenvYamlUrls({ content: devenvYaml, updates })
    expect(result.updatedInputs).toEqual([])
    expect(result.content).toBe(devenvYaml)
  })

  it('should handle single-quoted URL', () => {
    const content = `inputs:
  my-dep:
    url: 'github:owner/repo/old-ref'
`
    const updates = new Map<string, SourceUrlUpdate>([
      ['my-dep', { memberName: 'my-dep', newRef: 'new-ref' }],
    ])
    const result = rewriteDevenvYamlUrls({ content, updates })
    expect(result.updatedInputs).toEqual(['my-dep'])
    expect(result.content).toContain("    url: 'github:owner/repo/new-ref'")
  })
})

// =============================================================================
// rewriteLockFileRefs
// =============================================================================

describe('rewriteLockFileRefs', () => {
  const lockContent =
    JSON.stringify(
      {
        nodes: {
          root: {
            inputs: {
              'effect-utils': 'effect-utils',
              nixpkgs: 'nixpkgs',
            },
          },
          'effect-utils': {
            locked: {
              owner: 'overengineeringstudio',
              repo: 'effect-utils',
              rev: 'abc123',
              type: 'github',
            },
            original: {
              owner: 'overengineeringstudio',
              ref: 'main',
              repo: 'effect-utils',
              type: 'github',
            },
          },
          nixpkgs: {
            locked: {
              owner: 'NixOS',
              repo: 'nixpkgs',
              rev: 'def456',
              type: 'github',
            },
            original: {
              owner: 'NixOS',
              ref: 'nixos-unstable',
              repo: 'nixpkgs',
              type: 'github',
            },
          },
        },
        version: 7,
      },
      null,
      2,
    ) + '\n'

  it('should update original.ref for matching node', () => {
    const refUpdates = new Map([['effect-utils', 'schickling/2026-03-12-pnpm-refactor']])
    const result = rewriteLockFileRefs({ content: lockContent, refUpdates })
    expect(result.updatedNodes).toEqual(['effect-utils'])
    const parsed = JSON.parse(result.content)
    expect(parsed.nodes['effect-utils'].original.ref).toBe('schickling/2026-03-12-pnpm-refactor')
  })

  it('should preserve other nodes unchanged', () => {
    const refUpdates = new Map([['effect-utils', 'new-branch']])
    const result = rewriteLockFileRefs({ content: lockContent, refUpdates })
    const parsed = JSON.parse(result.content)
    expect(parsed.nodes.nixpkgs.original.ref).toBe('nixos-unstable')
    expect(parsed.nodes['effect-utils'].locked.rev).toBe('abc123')
  })

  it('should preserve key ordering via JSON.stringify', () => {
    const refUpdates = new Map([['effect-utils', 'new-branch']])
    const result = rewriteLockFileRefs({ content: lockContent, refUpdates })
    const parsed = JSON.parse(result.content)
    const originalKeys = Object.keys(parsed.nodes['effect-utils'].original)
    expect(originalKeys).toEqual(['owner', 'ref', 'repo', 'type'])
  })

  it('should skip non-existent nodes', () => {
    const refUpdates = new Map([['nonexistent', 'whatever']])
    const result = rewriteLockFileRefs({ content: lockContent, refUpdates })
    expect(result.updatedNodes).toEqual([])
  })

  it('should handle invalid JSON gracefully', () => {
    const result = rewriteLockFileRefs({
      content: 'not valid json',
      refUpdates: new Map([['a', 'b']]),
    })
    expect(result.updatedNodes).toEqual([])
    expect(result.content).toBe('not valid json')
  })

  it('should update multiple nodes', () => {
    const refUpdates = new Map([
      ['effect-utils', 'branch-a'],
      ['nixpkgs', 'nixos-24.11'],
    ])
    const result = rewriteLockFileRefs({ content: lockContent, refUpdates })
    expect(result.updatedNodes).toEqual(['effect-utils', 'nixpkgs'])
    const parsed = JSON.parse(result.content)
    expect(parsed.nodes['effect-utils'].original.ref).toBe('branch-a')
    expect(parsed.nodes.nixpkgs.original.ref).toBe('nixos-24.11')
  })

  it('should skip nodes without original field', () => {
    const content =
      JSON.stringify(
        {
          nodes: {
            root: { inputs: {} },
            'no-original': {
              locked: { owner: 'foo', repo: 'bar', type: 'github' },
            },
          },
          version: 7,
        },
        null,
        2,
      ) + '\n'
    const result = rewriteLockFileRefs({ content, refUpdates: new Map([['no-original', 'ref']]) })
    expect(result.updatedNodes).toEqual([])
  })
})
