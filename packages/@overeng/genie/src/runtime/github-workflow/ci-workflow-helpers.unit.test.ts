import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const ciWorkflowSource = readFileSync(
  new URL(['../../../../../../genie', 'ci-workflow.ts'].join('/'), import.meta.url),
  'utf8',
)
const generatedWorkflowSource = readFileSync(
  new URL(['../../../../../../.github/workflows', 'ci.yml.genie.ts'].join('/'), import.meta.url),
  'utf8',
)

const extractSourceBlock = (source: string, startMarker: string, endMarker: string) => {
  const start = source.indexOf(startMarker)
  if (start < 0) {
    throw new Error(`missing source block start: ${startMarker}`)
  }

  const end = source.indexOf(endMarker, start + startMarker.length)
  if (end < 0) {
    throw new Error(`missing source block end: ${endMarker}`)
  }

  return source.slice(start, end)
}

const pnpmDepsScanSource = extractSourceBlock(
  ciWorkflowSource,
  'const withEachPnpmDepsDrvShellLines = ({',
  '/** Evict cached pnpm-deps fixed-output outputs so CI re-derives them fresh. */',
)

const coldFreshBuildSource = extractSourceBlock(
  ciWorkflowSource,
  '/** Evict any cached pnpm-deps outputs below a flake target and rebuild it against cache.nixos.org only. */',
  '/**\n * Guard the pnpm dependency-prep contract against regressions that would',
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
    expect(ciWorkflowSource).toContain('const path = opts?.path ?? jobLocalPnpmHome')
  })

  it('cold-builds pnpm deps artifacts by evicting cached outputs before the second build', () => {
    expect(coldFreshBuildSource).toContain('installable="${drv}^*"')
    expect(coldFreshBuildSource).toContain(
      'outPath=$(nix path-info "$installable" 2>/dev/null || true)',
    )
    expect(coldFreshBuildSource).toContain('nix store delete "$outPath" 2>/dev/null || true')
    expect(coldFreshBuildSource).toContain(
      'nix build --no-link "$installable" --option substituters "https://cache.nixos.org"',
    )
  })

  it('prefers explicit depsBuildEntries metadata before falling back to closure scanning', () => {
    expect(pnpmDepsScanSource).toContain('$targetRef.passthru.depsBuildEntries')
    expect(pnpmDepsScanSource).toContain('(.drvPath // "")')
    expect(pnpmDepsScanSource).toContain('grep "pnpm-deps-[a-z0-9-]*-v[0-9]')
  })

  it('keeps the diagnostics summary portable', () => {
    expect(generatedWorkflowSource).toContain('head -n 120 "$markers_file"')
    expect(generatedWorkflowSource).not.toContain('sed -n "1,120p" "$markers_file"')
  })
})

describe('ci workflow shared auth helpers', () => {
  it('supports minting GitHub App installation tokens for downstream private inputs', () => {
    expect(ciWorkflowSource).toContain('export const githubAppInstallationTokenStep')
    expect(ciWorkflowSource).toContain("uses: 'actions/create-github-app-token@v2' as const")
  })

  it('lets installNixStep override the GitHub access token expression', () => {
    expect(ciWorkflowSource).toContain('githubAccessTokenExpression?: string')
    expect(ciWorkflowSource).toContain(
      "access-tokens = github.com=${opts?.githubAccessTokenExpression ?? '${{ github.token }}'}",
    )
  })

  it('can append GitHub access tokens to NIX_CONFIG for later shell steps', () => {
    expect(ciWorkflowSource).toContain('export const appendGitHubAccessTokenToNixConfigStep')
    expect(ciWorkflowSource).toContain('access-tokens = github.com=%s')
  })
})
