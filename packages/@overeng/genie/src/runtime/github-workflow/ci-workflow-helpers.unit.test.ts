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
const vercelDeploySource = readFileSync(
  new URL(['../../../../../../genie/deploy-preview', 'vercel.ts'].join('/'), import.meta.url),
  'utf8',
)
const nixGcRaceRetryScriptSource = readFileSync(
  new URL(
    ['../../../../../../genie/ci-scripts', 'nix-gc-race-retry.sh'].join('/'),
    import.meta.url,
  ),
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
    expect(nixGcRaceRetryScriptSource).toContain("tr '\\r\\n' '  ' < \"$log\"")
    expect(nixGcRaceRetryScriptSource).not.toContain("awk 'BEGIN { ORS=")
  })
})

describe('ci workflow pnpm cache defaults', () => {
  it('keeps the shared pnpm home workspace-relative', () => {
    expect(ciWorkflowSource).toContain(
      "export const jobLocalPnpmHome = '${{ github.workspace }}/.pnpm-home'",
    )
  })

  it('defaults the pnpm state helpers to restoring both home and auxiliary store state', () => {
    expect(ciWorkflowSource).toContain(
      "export const jobLocalPnpmStatePaths = [jobLocalPnpmHome, jobLocalPnpmStore].join('\\n')",
    )
    expect(ciWorkflowSource).toContain('const path = opts?.path ?? jobLocalPnpmStatePaths')
  })

  it('uses exact-key pnpm state restore semantics with an explicit versioned prefix', () => {
    expect(ciWorkflowSource).toContain("const keyPrefix = opts?.keyPrefix ?? 'pnpm-state-v1'")
    expect(ciWorkflowSource).toContain("name: 'Restore pnpm state'")
    expect(ciWorkflowSource).not.toContain("'restore-keys':")
  })

  it('only saves pnpm state after prior steps succeed', () => {
    expect(ciWorkflowSource).toContain("name: 'Save pnpm state'")
    expect(ciWorkflowSource).toContain(
      "if: `\\${{ success() && steps.${restoreStepId}.outputs.cache-hit != 'true' }}`",
    )
  })

  it('cold-builds pnpm deps artifacts by evicting cached outputs before the second build', () => {
    expect(coldFreshBuildSource).toContain('installable="${drv}^*"')
    expect(coldFreshBuildSource).toContain('while IFS= read -r outPath; do')
    expect(coldFreshBuildSource).toContain(
      'done < <(nix path-info "$installable" 2>/dev/null || true)',
    )
    expect(coldFreshBuildSource).toContain('...evictOutPathShellLines')
    expect(ciWorkflowSource).toContain('nix store delete --ignore-liveness "$outPath"')
    expect(ciWorkflowSource).toContain(
      'echo "::error::cached pnpm-deps output still present after eviction: $outPath"',
    )
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
    expect(ciWorkflowSource).toContain("uses: 'actions/create-github-app-token@v3' as const")
  })

  it('lets installNixStep override the GitHub access token expression', () => {
    expect(ciWorkflowSource).toContain('githubAccessTokenExpression?: string')
    expect(ciWorkflowSource).toContain(
      "access-tokens = github.com=${opts?.githubAccessTokenExpression ?? '${{ github.token }}'}",
    )
  })

  it('lets installNixStep disable Determinate summaries when runners reuse a preinstalled Nix', () => {
    expect(ciWorkflowSource).toContain('summarize?: boolean')
    expect(ciWorkflowSource).toContain('summarize: opts?.summarize ?? true')
  })

  it('exposes a dedicated env helper for self-hosted wrapper auth', () => {
    expect(ciWorkflowSource).toContain('export const githubAccessTokenEnv')
    expect(ciWorkflowSource).toContain('GITHUB_TOKEN: tokenExpression')
    expect(ciWorkflowSource).toContain('GH_TOKEN: tokenExpression')
    expect(ciWorkflowSource).toContain('export const withGitHubAccessTokenEnv')
  })

  it('can wrap shell steps with job-local private Cachix read auth', () => {
    expect(ciWorkflowSource).toContain('export const withPrivateCachixReadAuth')
    expect(ciWorkflowSource).toContain('CACHIX_AUTH_TOKEN: opts.authTokenExpression')
    expect(ciWorkflowSource).toContain(
      'cachix_netrc="$(mktemp "${RUNNER_TEMP:-/tmp}/cachix-netrc.XXXXXX")"',
    )
    expect(ciWorkflowSource).toContain('netrc-file = $cachix_netrc')
  })

  it('only appends GitHub access tokens to NIX_CONFIG through GITHUB_ENV', () => {
    expect(ciWorkflowSource).toContain('export const appendGitHubAccessTokenToNixConfigStep')
    expect(ciWorkflowSource).toContain('access-tokens = github.com=%s')
    expect(ciWorkflowSource).not.toContain(
      'printf "GITHUB_TOKEN=%s\\nGH_TOKEN=%s\\n" "$token" "$token"',
    )
  })

  it('pins the shared CI actions to the Node-24-safe majors', () => {
    expect(ciWorkflowSource).toContain("uses: 'actions/checkout@v6' as const")
    expect(ciWorkflowSource).toContain("uses: 'cachix/cachix-action@v17' as const")
  })

  it('lets Vercel deploy jobs decorate the deploy run step', () => {
    expect(ciWorkflowSource).toContain('deployStepDecorator?: (')
    expect(ciWorkflowSource).toContain('project: VercelProject')
    expect(vercelDeploySource).toContain('opts.deployStepDecorator?.(')
    expect(vercelDeploySource).toContain('vercelDeployStep(project, opts.runDevenvTasksBefore)')
  })
})
