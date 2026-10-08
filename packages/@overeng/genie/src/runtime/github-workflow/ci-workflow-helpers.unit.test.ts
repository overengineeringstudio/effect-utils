import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeAll, describe, expect, it } from 'vitest'

const ciWorkflowModuleRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))

const ciWorkflowSource = [
  'ci-workflow.ts',
  'ci-workflow/shared.ts',
  'ci-workflow/setup.ts',
  'ci-workflow/measurements.ts',
  'ci-workflow/reporting.ts',
  'ci-workflow/default-ref-policy-script.ts',
  'ci-workflow/megarepo.ts',
  'ci-workflow/merge-queue.ts',
  'ci-workflow/pr-reviews.ts',
  'ci-workflow/deploy.ts',
]
  .map((file) =>
    readFileSync(new URL(['../../../../../../genie', file].join('/'), import.meta.url), 'utf8'),
  )
  .join('\n')
const generatedWorkflowSource = readFileSync(
  new URL(['../../../../../../.github/workflows', 'ci.yml.genie.ts'].join('/'), import.meta.url),
  'utf8',
)
const generatedProductCiWorkflowYamlSource = readFileSync(
  new URL(['../../../../../../.github/workflows', 'ci.yml'].join('/'), import.meta.url),
  'utf8',
)
const generatedEmpiricalWorkflowYamlSource = readFileSync(
  new URL(
    ['../../../../../../.github/workflows', 'empirical-proofs.yml'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const generatedCiWorkflowYamlSource = [
  generatedProductCiWorkflowYamlSource,
  generatedEmpiricalWorkflowYamlSource,
].join('\n')

describe('pipeline traces image attachment', () => {
  // Modes that run the checked-in GitBucket adapter instead of a stub uploader.
  const adapterModes: Readonly<Record<string, true>> = {
    'oidc-429': true,
    'exchange-403': true,
    'upload-timeout': true,
  }
  it.each([
    'absent',
    'dry-run',
    'success',
    'dark-upload-failure',
    'private-url',
    'multiple-urls',
    'raster-failure',
    'oversized',
    'oidc-429',
    'exchange-403',
    'upload-timeout',
  ] as const)('preserves atomic report publication for %s', (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'pipeline-traces-assets-'))
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const executable = (name: string, body: string) => {
      const path = join(bin, name)
      writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`)
      chmodSync(path, 0o755)
      return path
    }
    const record = {
      kind: 'pipeline-traces',
      data: { rows: [{ job: 'build', status: 'success' }], omittedBars: 0 },
    }
    // The real collector emits marker-prefixed JSONL, never bare JSON records.
    writeFileSync(join(root, 'original.jsonl'), `WORKFLOW_REPORT_V1: ${JSON.stringify(record)}\n`)
    const ciTools = executable(
      'ci-tools',
      `
command="$1 $2"
shift 2
while (( $# )); do
  case "$1" in
    --output-path|--output-dir|--summary-path|--comment-body-path|--comment-id-path|--input-paths-json|--bundle-path) key="$1"; value="$2"; shift 2 ;;
    *) shift; continue ;;
  esac
  case "$command:$key" in
    'pipeline-report collect:--output-path') cp "$FIXTURE_ROOT/original.jsonl" "$value" ;;
    'pipeline-waterfall --input:--output-dir') mkdir -p "$value"; printf '<svg/>' | tee "$value/light.svg" > "$value/dark.svg" ;;
    'workflow-report collect-bundle:--input-paths-json') input="$(jq -r '.[0]' <<< "$value")" ;;
    'workflow-report collect-bundle:--output-path') sed -n 's/^WORKFLOW_REPORT_V1: //p' "$input" | jq -s '{records: .}' > "$value" ;;
    'workflow-report render-comment-body:--bundle-path') cp "$value" "$FIXTURE_ROOT/published.json" ;;
    'workflow-report render-comment-body:--summary-path') printf 'report rendered\\n' > "$value" ;;
    'workflow-report render-comment-body:--comment-body-path') printf 'comment rendered\\n' > "$value" ;;
    'workflow-report find-comment:--comment-id-path') : > "$value" ;;
  esac
done`,
    )
    executable('gh', "printf '[]\\n'")
    executable('nix', 'printf "%s\\n" "$FIXTURE_ROOT"')
    executable(
      'pipeline-waterfall-rasterizer',
      `
[[ "$FIXTURE_MODE" != raster-failure ]] || exit 1
if [[ "$FIXTURE_MODE" == oversized ]]; then
  truncate -s 5242881 "$2"
else
  printf '\\x89PNG\\r\\n\\x1a\\nfixture' > "$2"
fi`,
    )
    const uploader = executable(
      'asset uploader',
      `
printf '%s\\n' "$1" >> "$FIXTURE_ROOT/uploads"
theme="$(basename "$1" .png)"
case "$FIXTURE_MODE" in
  dark-upload-failure) printf 'secret-bearing diagnostic\\n' >&2; [[ "$theme" != dark ]] || exit 1 ;;
  private-url) printf 'https://private.invalid/%s.png\\n' "$theme"; exit 0 ;;
  multiple-urls) printf 'https://gitbucket.schickling.dev/one\\nhttps://gitbucket.schickling.dev/two\\n'; exit 0 ;;
esac
if [[ "$theme" == light ]]; then hash="${'a'.repeat(64)}"; else hash="${'b'.repeat(64)}"; fi
printf 'https://gitbucket.schickling.dev/api/get/%s\\n' "$hash"`,
    )
    // The checked-in GitBucket adapter runs against stubbed HTTP boundaries.
    // Authentication denials carry a body and diagnostics containing secrets.
    // upload-timeout: authentication succeeds and the upload times out after the
    // server already sent 200 headers, so the reason must be the exit code, not the status.
    // Every request records its endpoint and --max-time so the per-stage bounds are pinned.
    executable(
      'curl',
      `
output='' max_time='' url=''
while (( $# )); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --max-time) max_time="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s %s\\n' "\${url##*/}" "$max_time" >> "$FIXTURE_ROOT/curl-requests"
if [[ "$FIXTURE_MODE" == oidc-429 || ( "$FIXTURE_MODE" == exchange-403 && "$url" == */github-actions ) ]]; then
  status=429
  if [[ "$FIXTURE_MODE" == exchange-403 ]]; then status=403; fi
  printf '{"message":"secret-response-body"}' > "$output"
  printf 'curl: (22) The requested URL returned error: %s secret-response-body\\n' "$status" >&2
  printf '%s' "$status"
  exit 22
fi
case "$url" in
  */oidc) printf '{"value":"secret-response-body"}' > "$output" ;;
  */github-actions) printf '{"access_token":"secret-response-body"}' > "$output" ;;
  */upload) printf 'curl: (28) Operation timed out secret-response-body\\n' >&2; printf '200'; exit 28 ;;
esac
printf '200'`,
    )
    try {
      const result = spawnSync(
        'bash',
        [join(ciWorkflowModuleRoot, 'genie/ci-scripts/pipeline-traces-report.sh')],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            GH_TOKEN: 'fixture',
            GH_REPO: 'fixture/repository',
            PR_NUMBER: '1',
            GITHUB_RUN_ID: '2',
            GITHUB_RUN_ATTEMPT: '1',
            CI_TOOLS_BIN: ciTools,
            PIPELINE_REPORT_DRY_RUN: mode === 'dry-run' ? '1' : '0',
            GITHUB_STEP_SUMMARY: join(root, 'summary.md'),
            PIPELINE_TRACES_PUBLIC_ASSET_COMMAND:
              mode === 'absent' || adapterModes[mode] === true ? '' : uploader,
            ACTIONS_ID_TOKEN_REQUEST_URL:
              adapterModes[mode] === true ? 'https://fixture.invalid/oidc' : '',
            ACTIONS_ID_TOKEN_REQUEST_TOKEN:
              adapterModes[mode] === true ? 'fixture-request-token' : '',
            FIXTURE_ROOT: root,
            FIXTURE_MODE: mode,
          },
        },
      )
      expect(result.status, result.stderr).toBe(0)
      if (mode === 'dry-run') {
        expect(result.stdout).toContain('report rendered')
        expect(existsSync(join(root, 'summary.md'))).toBe(false)
      } else {
        expect(readFileSync(join(root, 'summary.md'), 'utf8')).toBe('report rendered\n')
      }
      for (const secret of [
        'secret-bearing diagnostic',
        'secret-response-body',
        'fixture-request-token',
      ])
        expect(result.stdout + result.stderr).not.toContain(secret)
      if (mode === 'oidc-429')
        expect(result.stdout).toContain(
          '::warning::Pipeline waterfall stage upload-light failed (oidc http 429); retaining jobs-only Mermaid report.',
        )
      if (mode === 'exchange-403')
        expect(result.stdout).toContain(
          '::warning::Pipeline waterfall stage upload-light failed (exchange http 403); retaining jobs-only Mermaid report.',
        )
      if (mode === 'upload-timeout') {
        expect(result.stdout).toContain(
          '::warning::Pipeline waterfall stage upload-light failed (upload exit 28); retaining jobs-only Mermaid report.',
        )
        // Authentication stays short; only the content upload gets the longer deadline.
        expect(readFileSync(join(root, 'curl-requests'), 'utf8')).toBe(
          'oidc 8\ngithub-actions 8\nupload 40\n',
        )
      }
      // An uploader whose last line is not the sanitized contract keeps the generic text.
      if (mode === 'dark-upload-failure')
        expect(result.stdout).toContain(
          '::warning::Pipeline waterfall stage upload-dark failed; retaining jobs-only Mermaid report.',
        )
      const published = JSON.parse(readFileSync(join(root, 'published.json'), 'utf8'))
      expect(published).toEqual({
        records: [
          mode === 'success'
            ? {
                ...record,
                data: {
                  ...record.data,
                  waterfall: {
                    lightUrl: `https://gitbucket.schickling.dev/api/get/${'a'.repeat(64)}`,
                    darkUrl: `https://gitbucket.schickling.dev/api/get/${'b'.repeat(64)}`,
                  },
                },
              }
            : record,
        ],
      })
      if (mode === 'absent' || mode === 'dry-run' || mode === 'success') {
        expect(result.stdout).not.toContain('::warning::')
      } else {
        expect(result.stdout).toContain('::warning::')
      }
      if (
        mode === 'absent' ||
        mode === 'dry-run' ||
        mode === 'raster-failure' ||
        mode === 'oversized'
      ) {
        expect(existsSync(join(root, 'uploads'))).toBe(false)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
const generatedAutoReviewWorkflowYamlSource = readFileSync(
  new URL(['../../../../../../.github/workflows', 'auto-review.yml'].join('/'), import.meta.url),
  'utf8',
)
const generatedRepoSettings = JSON.parse(
  readFileSync(
    new URL(['../../../../../../.github', 'repo-settings.json'].join('/'), import.meta.url),
    'utf8',
  ),
) as {
  rules: Array<{
    type: string
    parameters?: {
      required_status_checks?: Array<{ context: string }>
      required_review_thread_resolution?: boolean
    }
  }>
}
const generatedRepoSettingsSource = readFileSync(
  new URL(['../../../../../../.github', 'repo-settings.json.genie.ts'].join('/'), import.meta.url),
  'utf8',
)
const vercelDeploySource = readFileSync(
  new URL(['../../../../../../genie/deploy-preview', 'vercel.ts'].join('/'), import.meta.url),
  'utf8',
)
const netlifyDeploySource = readFileSync(
  new URL(['../../../../../../genie/deploy-preview', 'netlify.ts'].join('/'), import.meta.url),
  'utf8',
)
const workflowReportCommandSource = readFileSync(
  new URL(
    ['../../../../../../packages/@overeng/ci-tools/src', 'cli-command.ts'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const nixGcRaceRetryScriptUrl = new URL(
  ['../../../../../../genie/ci-scripts', 'nix-gc-race-retry.sh'].join('/'),
  import.meta.url,
)
const nixGcRaceRetryScriptPath = fileURLToPath(nixGcRaceRetryScriptUrl)
const nixGcRaceRetryScriptSource = readFileSync(nixGcRaceRetryScriptUrl, 'utf8')
const netlifyTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'netlify.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const vercelTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'vercel.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const workflowReportTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'workflow-report-module.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)
const buckToolchainsSource = readFileSync(
  new URL(['../../../../../../buck2/toolchains', 'BUCK'].join('/'), import.meta.url),
  'utf8',
)

const generatedRequiredCheckContexts =
  generatedRepoSettings.rules
    .find((rule) => rule.type === 'required_status_checks')
    ?.parameters?.required_status_checks?.map((check) => check.context) ?? []

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

const generatedDevenvPerfJob = extractSourceBlock(
  generatedCiWorkflowYamlSource,
  '  devenv-perf:',
  '  nix-closure-sizes:',
)

const restorePnpmStateStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const restorePnpmStateStep = (opts?: {',
  '/**\n * Save the job-local pnpm state after the main task graph runs.',
)

const validateNixStoreStepSource = extractSourceBlock(
  ciWorkflowSource,
  "export const validateNixStoreStepFor = (lockFile = 'devenv.lock') =>",
  '/**\n * Upload diagnostics captured by `validateNixStoreStep` as a CI artifact.',
)

const resolveDevenvScriptUrl = new URL(
  ['../../../../../../genie/ci-scripts', 'resolve-devenv.sh'].join('/'),
  import.meta.url,
)
const resolveDevenvScriptPath = fileURLToPath(resolveDevenvScriptUrl)
const resolveDevenvScript = readFileSync(resolveDevenvScriptUrl, 'utf8')

const applyMegarepoLockStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const applyMegarepoLockStep = (opts?: { skip?: string[]; cacheableStore?: boolean }) => {',
  "export const mergeQueueAdmissionLabel = 'mq:ci-admitted' as const",
)
const defaultRefPolicySource = readFileSync(
  new URL('../../../../../../genie/ci-workflow/default-ref-policy-script.ts', import.meta.url),
  'utf8',
)
const mergeQueueSource = extractSourceBlock(
  ciWorkflowSource,
  "export const mergeQueueAdmissionLabel = 'mq:ci-admitted' as const",
  'export const mergeQueueSemanticGateJob = ({',
)
const installMegarepoStepSource = extractSourceBlock(
  ciWorkflowSource,
  'export const installMegarepoStep = {',
  '/** Fetch latest refs and apply megarepo workspace. */',
)
const megarepoTaskModuleSource = readFileSync(
  new URL(
    ['../../../../../../nix/devenv-modules/tasks/shared', 'megarepo.nix'].join('/'),
    import.meta.url,
  ),
  'utf8',
)

describe('pull request control-event workflows', () => {
  it('finishes the auto-review suite successfully when no review request is needed', () => {
    expect(generatedAutoReviewWorkflowYamlSource).not.toMatch(
      /  request-review:\n    if: github\.event\.pull_request/,
    )
    expect(generatedAutoReviewWorkflowYamlSource).toContain(
      "      - name: Request review from schickling\n        if: github.event.pull_request.user.login == 'schickling-assistant' && github.event.pull_request.draft == false",
    )
  })
})

describe('protected-main archive seeding', () => {
  it('keeps the archive CAS write credential out of every CI job', () => {
    // The CAS host seeds itself from main (decision 0038, amendment 1); no runner holds the token.
    expect(generatedCiWorkflowYamlSource).not.toContain('BUCK2_ARCHIVE_CAS_AUTHORIZATION')
    expect(generatedCiWorkflowYamlSource).not.toContain('buck2:archives:seed')
    expect(generatedCiWorkflowYamlSource).not.toContain('trusted-cache.example')
  })
})

describe('ci workflow retry helpers', () => {
  it('emits compact calls to the checked-in retry helper script', () => {
    expect(ciWorkflowSource).toContain("defaultCiRuntimeScriptsDir = 'genie/ci-scripts'")
    expect(ciWorkflowSource).toContain(
      'preparedCiRuntimeScriptsDir = `${ciCompositionStateRoot}/ci-runtime`',
    )
    expect(ciWorkflowSource).toContain('prepareCiScriptsStep')
    expect(ciWorkflowSource).toContain('rm -f "$scripts_dst"/*.genie.ts')
    expect(ciWorkflowSource).toContain('createRunDevenvTasksBefore')
    expect(ciWorkflowSource).toContain('run-with-nix-gc-race-retry.sh')
    expect(ciWorkflowSource).not.toContain('const nixGcRaceRetryScript = String.raw')
    expect(generatedCiWorkflowYamlSource).not.toContain('__nix_gc_retry_helper=$(mktemp)')
    expect(generatedCiWorkflowYamlSource).toContain('run-with-nix-gc-race-retry.sh')
    expect(nixGcRaceRetryScriptSource).toContain('run_nix_gc_race_retry')
    expect(nixGcRaceRetryScriptSource).toContain('mkfifo "$stdout_pipe" "$stderr_pipe"')
    expect(nixGcRaceRetryScriptSource).toContain('"$@" > "$stdout_pipe" 2> "$stderr_pipe"')
    expect(nixGcRaceRetryScriptSource).not.toContain('eval "$command"')
    expect(nixGcRaceRetryScriptSource).toContain("tr '\\r\\n' '  ' < \"$log\"")
    expect(nixGcRaceRetryScriptSource).not.toContain('repair_nix_daemon')
    expect(nixGcRaceRetryScriptSource).not.toContain('sudo systemctl')
    expect(nixGcRaceRetryScriptSource).not.toContain('sudo launchctl')
    expect(nixGcRaceRetryScriptSource).not.toContain("awk 'BEGIN { ORS=")
  })

  it('keeps the retry helper script path configurable for downstream workflows', () => {
    expect(ciWorkflowSource).toContain('createRunDevenvTasksBefore')
    expect(ciWorkflowSource).toContain('opts.scriptsDir === undefined')
    expect(ciWorkflowSource).not.toContain('if [ ! -x "$__genie_ci_retry_script" ]')
  })

  it('captures ordinary CI task graphs as OpenTelemetry artifacts', () => {
    expect(ciWorkflowSource).toContain('prepareCiOtelSpoolStep')
    expect(ciWorkflowSource).toContain('ciOtelSpansArtifactStep')
    expect(generatedCiWorkflowYamlSource).toContain('name: Prepare CI OpenTelemetry capture')
    expect(generatedCiWorkflowYamlSource).toContain('OTEL_SPAN_SPOOL_DIR')
    expect(generatedCiWorkflowYamlSource).toContain('name: Summarize CI OpenTelemetry spans')
    expect(generatedCiWorkflowYamlSource).toContain('name: Upload CI OpenTelemetry spans')
    const captureCount = generatedCiWorkflowYamlSource.match(
      /name: Prepare CI OpenTelemetry capture/g,
    )?.length
    const uploadCount = generatedCiWorkflowYamlSource.match(
      /name: Upload CI OpenTelemetry spans/g,
    )?.length
    expect(captureCount).toBeGreaterThan(0)
    expect(uploadCount).toBe(captureCount)
  })

  it('routes the devenv resolution step through the shared retry wrapper', () => {
    expect(validateNixStoreStepSource).toContain('withGcRaceRetry({')
    expect(validateNixStoreStepSource).toContain('label: `resolve devenv (${lockFile})`')
    expect(generatedCiWorkflowYamlSource).toContain(
      'bash "$__genie_ci_retry_script" \'resolve devenv (devenv.lock)\'',
    )
  })

  it('classifies an incompletely cached flake input as a bounded transient', () => {
    expect(nixGcRaceRetryScriptSource).toContain('saw_missing_flake_subpath')
    // Anchored on the guillemet-wrapped flake reference Nix prints, so a genuinely absent
    // store path reported with the same wording is not misread as transient.
    expect(nixGcRaceRetryScriptSource).toContain("flake_ref_open=$'\\302\\253'")
    expect(nixGcRaceRetryScriptSource).toContain("flake_ref_close=$'\\302\\273'")
    expect(nixGcRaceRetryScriptSource).toContain(
      "grep -o \"error:[[:space:]]*path '${flake_ref_open}[^']*${flake_ref_close}[^']*' does not exist\"",
    )
    // Determinate Nix versions these caches; the bare legacy names match nothing, and a
    // sqlite database removed without its -shm/-wal sidecars leaves a corrupt cache.
    expect(nixGcRaceRetryScriptSource).toContain(
      'nix_cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/nix"',
    )
    expect(nixGcRaceRetryScriptSource).toContain('"$nix_cache_root"/tarball-cache-v*')
    expect(nixGcRaceRetryScriptSource).toContain('"$nix_cache_root"/gitv*')
    expect(nixGcRaceRetryScriptSource).toContain('"$nix_cache_root"/fetcher-cache-v*.sqlite*')
    expect(nixGcRaceRetryScriptSource).toContain('repaired_missing_subpaths')
    expect(nixGcRaceRetryScriptSource).toContain(
      'for repaired_missing_subpath in "${repaired_missing_subpaths[@]}"',
    )
    expect(nixGcRaceRetryScriptSource).not.toContain('missing_subpath_repairs=')
    expect(nixGcRaceRetryScriptSource).toContain(
      '[ "${repaired_missing_subpaths[0]+present}" = present ]',
    )
    expect(nixGcRaceRetryScriptSource).toContain(
      'rm -rf ~/.cache/nix/eval-cache-* "$nix_cache_root"/eval-cache-*',
    )
    // A second identical failure is an error carrying its own summary note and the
    // original exit code, never the generic no-transient-signature path.
    expect(nixGcRaceRetryScriptSource).toContain(
      '::error::Nix flake input subpath still missing for $task',
    )
    expect(nixGcRaceRetryScriptSource).toContain(
      'write_summary failure "Nix flake input subpath still missing after one cache repair',
    )
    // ASCII-only template: a guillemet in the generator can be re-encoded as an escape
    // sequence that String.raw would emit literally into the shipped script.
    expect(nixGcRaceRetryScriptSource).not.toContain('\\u00AB')
    expect(nixGcRaceRetryScriptSource).not.toContain('\u00AB')
  })

  it('repairs each distinct missing flake subpath once before treating a repeat as permanent', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-nix-gc-retry-subpaths-'))
    const fixture = join(root, 'missing-subpaths.sh')
    const attempts = join(root, 'attempts')
    const firstPath = '«github:NixOS/nixpkgs/first»/pkgs/first'
    const secondPath = '«github:NixOS/nixpkgs/second»/pkgs/second'
    writeFileSync(
      fixture,
      `#!/usr/bin/env bash
set -euo pipefail
attempt=$(($(cat "$ATTEMPTS" 2>/dev/null || echo 0) + 1))
printf '%s' "$attempt" > "$ATTEMPTS"
case "$attempt" in
  1) missing_path='${firstPath}' ;;
  *) missing_path='${secondPath}' ;;
esac
printf "error: path '%s' does not exist\\n" "$missing_path" >&2
exit "$attempt"
`,
    )
    chmodSync(fixture, 0o755)
    try {
      const result = spawnSync(
        'bash',
        ['-c', 'set -u; . "$RETRY_SCRIPT"; run_nix_gc_race_retry path-tracking "$FIXTURE"'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            ATTEMPTS: attempts,
            CI_PROGRESS_HEARTBEAT_SECONDS: '1',
            FIXTURE: fixture,
            HOME: join(root, 'home'),
            NIX_GC_RACE_MAX_RETRIES: '10',
            RETRY_SCRIPT: nixGcRaceRetryScriptPath,
            XDG_CACHE_HOME: join(root, 'cache'),
          },
        },
      )
      const output = `${result.stdout}\n${result.stderr}`
      expect(result.status, output).toBe(3)
      expect(readFileSync(attempts, 'utf8')).toBe('3')
      expect(output).toContain(
        `Incomplete Nix flake input cache detected for path-tracking (attempt 1/10): ${firstPath}`,
      )
      expect(output).toContain(
        `Incomplete Nix flake input cache detected for path-tracking (attempt 2/10): ${secondPath}`,
      )
      expect(output).toContain(
        `Nix flake input subpath still missing for path-tracking after one cache repair: ${secondPath}`,
      )
      expect(output).not.toContain(
        `Nix flake input subpath still missing for path-tracking after one cache repair: ${firstPath}`,
      )
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('prepares retry helpers before generated jobs use the prepared retry script', () => {
    const jobBlocks = generatedCiWorkflowYamlSource.split(/\n  [a-zA-Z0-9_-]+:\n/g).slice(1)

    for (const jobBlock of jobBlocks) {
      const helperIndex = jobBlock.indexOf(
        '${{ runner.temp }}/composition-state/ci-runtime/run-with-nix-gc-race-retry.sh',
      )
      if (helperIndex < 0) continue

      const checkoutIndex = jobBlock.indexOf('uses: actions/checkout@v6')
      const installNixIndex = jobBlock.indexOf('uses: DeterminateSystems/determinate-nix-action@v3')
      const prepareIndex = jobBlock.indexOf('Prepare CI helper scripts')
      const baselineCheckoutIndex = jobBlock.indexOf('Checkout CI measurement baseline ref')
      expect(checkoutIndex).toBeGreaterThanOrEqual(0)
      expect(checkoutIndex).toBeLessThan(helperIndex)
      expect(installNixIndex).toBeGreaterThanOrEqual(0)
      expect(installNixIndex).toBeLessThan(prepareIndex)
      expect(prepareIndex).toBeGreaterThanOrEqual(0)
      expect(prepareIndex).toBeLessThan(helperIndex)
      if (baselineCheckoutIndex >= 0) {
        expect(baselineCheckoutIndex).toBeLessThan(prepareIndex)
      }
    }
  })
})

describe('ci workflow reporting helpers', () => {
  it('keeps structured workflow report records on the marked JSONL path', () => {
    expect(ciWorkflowSource).toContain('encodeWorkflowReportRecordLine')
    expect(ciWorkflowSource).toContain('workflowReportProducerStep')
    expect(ciWorkflowSource).toContain('workflowReportCollectorStep')
    expect(ciWorkflowSource).toContain('workflowReportPublisherStep')
  })

  it('matches managed PR comments by hidden state ID before patching', () => {
    expect(ciWorkflowSource).toContain('workflow-report')
    expect(ciWorkflowSource).toContain('workflow-report:publish')
    expect(workflowReportTaskModuleSource).toContain('find-comment')
    expect(workflowReportTaskModuleSource).toContain(
      'workflow report PR comment skipped for fork pull request',
    )
    expect(workflowReportCommandSource).toContain(
      'workflow report comment body is missing managed state',
    )
    expect(workflowReportCommandSource).toContain('findWorkflowReportManagedComment')
    expect(ciWorkflowSource).toContain('WORKFLOW_REPORT_STATE_ID')
  })
})

describe('ci workflow pnpm cache defaults', () => {
  it('keeps pnpm home stable under runner composition state', () => {
    expect(ciWorkflowSource).toContain(
      'export const ciPnpmHome = `${ciCompositionStateRoot}/pnpm-home`',
    )
  })

  it('defaults the pnpm state helpers to restoring both home and auxiliary store state', () => {
    expect(ciWorkflowSource).toContain(
      'export const ciPnpmStatePaths = [ciPnpmHome, ciPnpmStore].join(',
    )
    expect(ciWorkflowSource).toContain('const path = opts?.path ?? ciPnpmStatePaths')
  })

  it('exports PNPM_CONFIG_STORE_DIR alongside pnpm store state', () => {
    expect(ciWorkflowSource).toContain(
      '`echo "PNPM_CONFIG_STORE_DIR=${ciPnpmStore}" >> "$GITHUB_ENV"`',
    )
  })

  it('uses exact-key pnpm state restore semantics with an explicit versioned prefix', () => {
    expect(restorePnpmStateStepSource).toContain(
      'const keyPrefix = opts?.keyPrefix ?? defaultPnpmStateKeyPrefix',
    )
    expect(restorePnpmStateStepSource).toContain(
      'const hashFilesExpression = opts?.hashFilesExpression ?? defaultPnpmStateHashFilesExpression',
    )
    expect(restorePnpmStateStepSource).toContain("name: 'Restore pnpm state'")
    expect(restorePnpmStateStepSource).not.toContain("'restore-keys':")
  })

  it('centralizes the pnpm state cache contract version at v3', () => {
    expect(ciWorkflowSource).toContain("export const pnpmStateCacheVersion = 'v3'")
    expect(ciWorkflowSource).toContain("export const defaultPnpmStateKeyPrefix = 'pnpm-state'")
    expect(ciWorkflowSource).toContain(
      `const defaultPnpmStateHashFilesExpression = "\${{ hashFiles('**/pnpm-lock.yaml') }}"`,
    )
    expect(ciWorkflowSource).toContain('`${args.keyPrefix}-${pnpmStateCacheVersion}-')
  })

  it('allows repositories to narrow pnpm state hashing without redefining cache steps', () => {
    expect(ciWorkflowSource).toContain('hashFilesExpression?: string')
    expect(ciWorkflowSource).toContain(
      'pnpmStateCachePrimaryKey({ keyPrefix, hashFilesExpression })',
    )
  })

  it('uses identical stable restore/save paths for pnpm and Nix caches', async () => {
    const { restoreNixCacheStep, restorePnpmStateStep, saveNixCacheStep, savePnpmStateStep } =
      await import(
        // oxlint-disable-next-line import/no-dynamic-require
        new URL('../../../../../../genie/ci-workflow/setup.ts', import.meta.url).href
      )
    const pnpmRestore = restorePnpmStateStep()
    const pnpmSave = savePnpmStateStep()
    const nixRestore = restoreNixCacheStep()
    const nixSave = saveNixCacheStep()
    expect(pnpmRestore.with.path).toBe(pnpmSave.with.path)
    expect(nixRestore.with.path).toBe(nixSave.with.path)
    expect(pnpmRestore.with.path).not.toContain('github.run_id')
    expect(nixRestore.with.path).not.toContain('github.run_id')
  })

  it('keeps the pnpm store definition stable without caching it in CI', () => {
    expect(ciWorkflowSource).toContain(
      'export const ciPnpmStore = `${ciCompositionStateRoot}/pnpm-store-pure-v1`',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain(
      '${{ runner.temp }}/composition-state/pnpm-store-pure-v1',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain('${{ github.workspace }}/.pnpm-store')
    expect(ciWorkflowSource).toContain(
      "ciCompositionStateRoot = '${{ runner.temp }}/composition-state'",
    )
  })

  it('exposes a callable single-publisher primitive and delegates the composer to it', () => {
    expect(ciWorkflowSource).toContain('export const pnpmStatePublisherPostSteps = (opts?: {')
    expect(ciWorkflowSource).toContain('export const withSinglePnpmStatePublisher = <')
    expect(ciWorkflowSource).toContain(
      'opts?.publish === true ? [savePnpmStateStep(opts?.save)] : []',
    )
    expect(ciWorkflowSource).toContain('...pnpmStatePublisherPostSteps({')
  })

  it('only saves pnpm state after prior steps succeed', () => {
    expect(ciWorkflowSource).toContain("name: 'Save pnpm state'")
    expect(ciWorkflowSource).toContain(
      "if: `\\${{ success() && steps.${restoreStepId}.outputs.cache-hit != 'true' }}`",
    )
  })

  it('keeps the diagnostics summary portable', () => {
    expect(generatedWorkflowSource).toContain('head -n 120 "$markers_file"')
    expect(generatedWorkflowSource).not.toContain('sed -n "1,120p" "$markers_file"')
  })

  it('captures process snapshots without leaking full argv', () => {
    expect(ciWorkflowSource).toContain('stat,comm --sort=-%cpu')
    expect(ciWorkflowSource).toContain('stat,comm -r | head -15')
    expect(ciWorkflowSource).not.toContain('stat,command --sort=-%cpu')
    expect(ciWorkflowSource).not.toContain('stat,command -r | head -15')
  })

  it('purges nix eval cache from the active XDG cache root during repair', () => {
    expect(resolveDevenvScript).toContain(
      'rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}"/nix/eval-cache-* ~/.cache/nix/eval-cache-*',
    )
  })

  it('quotes caller-selected devenv lock paths', () => {
    expect(ciWorkflowSource).toContain(
      'jq -r .nodes.devenv.locked.rev ${shellSingleQuote(lockFile)}',
    )
    expect(ciWorkflowSource).toContain(
      "printf '::error::%s missing .nodes.devenv.locked.rev\\\\n' ${shellSingleQuote(lockFile)}",
    )
  })

  it('retries initial devenv resolution once only for an extracted invalid store path', () => {
    expect(resolveDevenvScript).toContain('[ -n "$invalid_path" ] || return "$rc"')
    expect(resolveDevenvScript.match(/resolve_devenv_once/g)).toHaveLength(3)
    expect(resolveDevenvScript).toContain('nix-store --repair-path "$invalid_path"')
    expect(resolveDevenvScript).not.toContain('Failed to convert config.cachix to JSON')
    expect(resolveDevenvScript).not.toContain('Truncated tar archive')
  })

  it('preserves a non-signature resolution failure status without retrying', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-resolve-devenv-no-retry-'))
    const bin = join(root, 'bin')
    const attempts = join(root, 'attempts')
    const existingOutput = join(root, 'existing-output')
    const existingRootDir = join(root, 'genie-nix-gc-roots')
    const existingRoot = join(existingRootDir, 'devenv-no-retry-1-unit')
    mkdirSync(bin)
    mkdirSync(existingOutput)
    mkdirSync(existingRootDir)
    symlinkSync(existingOutput, existingRoot)
    writeFileSync(
      join(bin, 'nix'),
      `#!/usr/bin/env bash\nprintf 'attempt\\n' >> "$NIX_ATTEMPTS"\necho 'ordinary failure' >&2\nexit 23\n`,
    )
    chmodSync(join(bin, 'nix'), 0o755)
    try {
      const result = spawnSync(
        'bash',
        ['-c', '. "$RESOLVE_DEVENV_SCRIPT"; DEVENV_REV=fixture; resolve_devenv'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_JOB: 'unit',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_RUN_ID: 'no-retry',
            NIX_ATTEMPTS: attempts,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            RESOLVE_DEVENV_SCRIPT: resolveDevenvScriptPath,
            RUNNER_TEMP: root,
          },
        },
      )
      expect(result.status).toBe(23)
      expect(readFileSync(attempts, 'utf8')).toBe('attempt\n')
      expect(readlinkSync(existingRoot)).toBe(existingOutput)
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('repairs an invalid path and atomically roots the successful retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-resolve-devenv-retry-'))
    const bin = join(root, 'bin')
    const attempts = join(root, 'attempts')
    const roots = join(root, 'roots')
    const repairs = join(root, 'repairs')
    const summary = join(root, 'summary')
    const output = join(root, 'devenv-output')
    mkdirSync(bin)
    mkdirSync(output)
    writeFileSync(
      join(bin, 'nix'),
      `#!/usr/bin/env bash
set -euo pipefail
attempt=1
if [ -f "$NIX_ATTEMPTS" ]; then attempt=$(( $(wc -l < "$NIX_ATTEMPTS") + 1 )); fi
printf 'attempt\\n' >> "$NIX_ATTEMPTS"
out_link=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--out-link' ]; then out_link="$2"; shift 2; else shift; fi
done
printf '%s\\n' "$out_link" >> "$NIX_ROOTS"
if [ "$attempt" -eq 1 ]; then
  echo "error: path '/nix/store/missing-fixture.drv' is not valid" >&2
  exit 17
fi
ln -s "$NIX_OUTPUT" "$out_link"
printf '%s\\n' "$NIX_OUTPUT"
`,
    )
    writeFileSync(
      join(bin, 'nix-store'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$NIX_REPAIRS"\nexit 0\n`,
    )
    chmodSync(join(bin, 'nix'), 0o755)
    chmodSync(join(bin, 'nix-store'), 0o755)
    try {
      const result = spawnSync(
        'bash',
        ['-c', '. "$RESOLVE_DEVENV_SCRIPT"; DEVENV_REV=fixture; resolve_devenv'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_JOB: 'unit',
            GITHUB_RUN_ATTEMPT: '1',
            GITHUB_RUN_ID: 'retry',
            GITHUB_STEP_SUMMARY: summary,
            NIX_ATTEMPTS: attempts,
            NIX_OUTPUT: output,
            NIX_REPAIRS: repairs,
            NIX_ROOTS: roots,
            PATH: `${bin}:${process.env.PATH ?? ''}`,
            RESOLVE_DEVENV_SCRIPT: resolveDevenvScriptPath,
            RUNNER_TEMP: root,
          },
        },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(`${output}\n`)
      expect(readFileSync(attempts, 'utf8')).toBe('attempt\nattempt\n')
      const [firstRoot, secondRoot] = readFileSync(roots, 'utf8').trim().split('\n')
      expect(firstRoot).toBe(secondRoot)
      expect(readFileSync(repairs, 'utf8')).toContain(
        '--repair-path /nix/store/missing-fixture.drv',
      )
      expect(readlinkSync(firstRoot!)).toBe(output)
      expect(readFileSync(summary, 'utf8')).toContain('### Recovered Nix store lifecycle incident')
      expect(readFileSync(summary, 'utf8')).toContain('- Attempts: 2/2')
    } finally {
      rmSync(root, { force: true, recursive: true })
    }
  })

  it('roots the resolved devenv closure in runner job scratch space', () => {
    expect(resolveDevenvScript).toContain('${RUNNER_TEMP:-/tmp}/genie-nix-gc-roots')
    expect(resolveDevenvScript).toContain('--out-link "$DEVENV_GC_ROOT"')
    expect(resolveDevenvScript).not.toContain('rm -f "$DEVENV_GC_ROOT"')
    expect(resolveDevenvScript).toContain(
      '${GITHUB_RUN_ID:-local-$$}-${GITHUB_RUN_ATTEMPT:-0}-${GITHUB_JOB:-job}',
    )
    expect(resolveDevenvScript).toContain('[ ! "$DEVENV_GC_ROOT" -ef "$DEVENV_OUT" ]')
    expect(resolveDevenvScript).not.toContain('readlink -e')
    expect(validateNixStoreStepSource).toContain('resolve-devenv.sh')
    expect(validateNixStoreStepSource).not.toContain('resolve-devenv-ci.sh')
    // The invocation is now nested inside the retry wrapper's single-quoted command, so
    // the script reference carries the escaped inner quotes.
    expect(generatedCiWorkflowYamlSource).toContain(
      `'"'"'\${{ runner.temp }}/composition-state/ci-runtime/resolve-devenv.sh'"'"'`,
    )
    expect(generatedCiWorkflowYamlSource).not.toContain('resolve_devenv_once()')
    expect(
      existsSync(
        new URL(
          ['../../../../../../genie/ci-scripts', 'resolve-devenv-ci.sh'].join('/'),
          import.meta.url,
        ),
      ),
    ).toBe(false)
  })

  it('resolves the locked megarepo CLI through a git flake URL', () => {
    expect(applyMegarepoLockStepSource).toContain(
      'nix run "github:overengineeringstudio/effect-utils/$EU_REV#megarepo"',
    )
    expect(applyMegarepoLockStepSource).not.toContain(
      'nix run "github:overengineeringstudio/effect-utils?ref=$EU_REF&rev=$EU_REV#megarepo"',
    )
  })

  it('installs setup-time megarepo from the locked effect-utils commit without mutating nix profiles', () => {
    expect(installMegarepoStepSource).toContain(
      'MR_REF="github:overengineeringstudio/effect-utils/$EU_REV#megarepo"',
    )
    expect(installMegarepoStepSource).toContain(
      'MR_OUT=$(nix build --no-link --print-out-paths "$MR_REF")',
    )
    expect(installMegarepoStepSource).toContain('${appendGitHubPathLine(\'"$MR_BIN_DIR"\')}')
    expect(installMegarepoStepSource).not.toContain('nix profile install')
  })

  it('only exports skipped megarepo members when the CI lane actually skips members', () => {
    expect(applyMegarepoLockStepSource).toContain('MEGAREPO_SKIP_MEMBERS')
    expect(applyMegarepoLockStepSource).toContain("skipCsv === ''")
    expect(applyMegarepoLockStepSource).toContain(
      "appendGitHubEnvLine({ name: 'MEGAREPO_SKIP_MEMBERS', valueExpression: quotedSkipCsv })",
    )
  })

  it('keeps GitHub env/path printf newlines escaped in shared megarepo steps', () => {
    expect(ciWorkflowSource).toContain('const appendGitHubPathLine = (valueExpression: string)')
    expect(ciWorkflowSource).toContain('`printf \'%s\\\\n\' ${valueExpression} >> "$GITHUB_PATH"`')
    expect(ciWorkflowSource).toContain(
      '`printf \'${name}=%s\\\\n\' ${valueExpression} >> "$GITHUB_ENV"`',
    )
    expect(installMegarepoStepSource).not.toContain("printf '%s\n'")
    expect(applyMegarepoLockStepSource).not.toContain("printf 'MEGAREPO_STORE=%s\n'")
    expect(applyMegarepoLockStepSource).not.toContain("printf 'MEGAREPO_SKIP_MEMBERS=%s\n'")
    expect(generatedCiWorkflowYamlSource).not.toContain("printf '%s\n")
    expect(generatedCiWorkflowYamlSource).not.toContain("printf 'MEGAREPO_STORE=%s\n")
    expect(generatedCiWorkflowYamlSource).not.toContain("printf 'MEGAREPO_SKIP_MEMBERS=%s\n")
  })

  it('passes skipped megarepo members as one comma-separated CLI option', () => {
    expect(megarepoTaskModuleSource).toContain('MR_SKIP_ARGS+=(--skip "$_mr_skip_csv")')
    expect(megarepoTaskModuleSource).not.toContain('MR_SKIP_ARGS+=(--skip "$member")')
  })

  it('accepts current, historical, and nested mr ls success payloads', () => {
    expect(megarepoTaskModuleSource).toContain(
      '(.members // .value.members // .value.value.members // [])',
    )
    expect(megarepoTaskModuleSource).not.toContain('.value.members[].name')
  })

  it('keeps the source-policy trust gate available before composition', () => {
    expect(defaultRefPolicySource).toContain('NORMALIZE_GIT_BRANCH_REFS')
    expect(defaultRefPolicySource).toContain("ref.startsWith('refs/heads/')")
  })

  it('allows only explicitly opted-in immutable legacy member refs', () => {
    expect(defaultRefPolicySource).toContain('ALLOW_LEGACY_MEMBER_COMMIT_REFS')
    expect(defaultRefPolicySource).toContain("memberName.endsWith('-legacy')")
    expect(defaultRefPolicySource).toContain(
      'const immutableCommitRef = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i',
    )
    expect(defaultRefPolicySource).toContain(
      'isAllowedLegacyMemberRef({ memberName, ref: normalizedRef })',
    )
  })

  it('retries temporary git repository cleanup after reachability checks', () => {
    expect(defaultRefPolicySource).toContain(
      'fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })',
    )
  })

  it('runs the dedicated default-ref policy job before composition', () => {
    expect(generatedWorkflowSource).toContain("'default-ref-policy': {")
    expect(generatedWorkflowSource).toContain('defaultRefPolicyCheckJob({')
    expect(generatedWorkflowSource).not.toContain("runDevenvTasksBefore('policy:default-ref')")
    expect(ciWorkflowSource).toContain('defaultRefPolicyCheckJob')
    expect(ciWorkflowSource).toContain('defaultRefPolicyCheckStep(stepOpts)')
  })
})

describe('ci workflow merge queue helpers', () => {
  it('centralizes the Hypermerge semantic required checks and admission label expressions', () => {
    expect(mergeQueueSource).toContain('mergeQueueRequiredCIJobs')
    expect(mergeQueueSource).toContain('mq/admission')
    expect(mergeQueueSource).toContain('pr/quality')
    expect(mergeQueueSource).toContain('pr/topology')
    expect(mergeQueueSource).toContain('pr/freshness')
    expect(mergeQueueSource).toContain('pr/contract')
    expect(mergeQueueSource).toContain('mq:ci-admitted')
  })

  it('preserves label control-event concurrency for scarce self-hosted runners', () => {
    expect(mergeQueueSource).toContain('mergeQueueWorkflowConcurrency')
    expect(mergeQueueSource).toContain('mergeQueueWorkflowOn')
    expect(mergeQueueSource).toContain('merge_group: githubWorkflowEvent.all')
    expect(mergeQueueSource).toContain("format('label-{0}', github.event.label.name)")
    expect(mergeQueueSource).toContain(
      "github.event.action != 'labeled' && github.event.action != 'unlabeled'",
    )
  })

  it('exports reusable admission and semantic gate jobs', () => {
    expect(ciWorkflowSource).toContain('export const mergeQueueAdmissionGateJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueAdmittedJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueSemanticGateJob')
    expect(ciWorkflowSource).toContain('export const mergeQueueSemanticGateJobs')
    expect(ciWorkflowSource).toContain('trustNeedsAdmission: true')
    expect(ciWorkflowSource).toContain('requiredGateCheckName(name)')
  })

  it('hardens dynamic semantic gate names and admission-job permissions', async () => {
    const { mergeQueueAdmittedJob, mergeQueueWorkflowOn, requiredGateCheckName } = (await import(
      // oxlint-disable-next-line import/no-dynamic-require
      new URL('../../../../../../genie/ci-workflow/merge-queue.ts', import.meta.url).href
    )) as any

    expect(requiredGateCheckName("pr/quality's gate")).toBe(
      "${{ ((github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') || (github.event.action == 'labeled' && github.event.label.name == 'mq:ci-admitted')) && (github.event_name != 'pull_request' || (contains(github.event.pull_request.labels.*.name, 'mq:ci-admitted') || (github.event.action == 'labeled' && github.event.label.name == 'mq:ci-admitted')))) && 'pr/quality''s gate' || 'pr/quality''s gate (control event)' }}",
    )

    const runsOn = ['sh-linux-x64', 'nix'] as const
    const admittedJob = mergeQueueAdmittedJob({
      runsOn,
      permissions: { actions: 'read' },
      steps: [{ name: 'Proof', run: 'true' }],
    })

    expect(admittedJob['runs-on']).toEqual(['sh-linux-x64', 'nix'])
    expect(admittedJob['runs-on']).not.toBe(runsOn)
    expect(admittedJob.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'read',
      'pull-requests': 'read',
    })
    expect(mergeQueueWorkflowOn()).toMatchObject({
      merge_group: { _tag: 'GitHubWorkflowEventAll' },
    })
  }, 20_000)
})

describe('ci workflow pr-reviews helpers', () => {
  it('exposes a reusable review-thread resolution gate and ruleset rule', () => {
    expect(ciWorkflowSource).toContain('export const prReviewsResolvedJobId')
    expect(ciWorkflowSource).toContain('export const prReviewsResolvedStep')
    expect(ciWorkflowSource).toContain('export const prReviewsResolvedJob')
    expect(ciWorkflowSource).toContain('export const prReviewsPullRequestRule')
    expect(ciWorkflowSource).toContain('required_review_thread_resolution: true')
    expect(ciWorkflowSource).toContain('reviewThreads(first:100')
    expect(ciWorkflowSource).toContain('isResolved')
  })

  it('wires pr-reviews-resolved into the generated workflow and repo settings', () => {
    expect(generatedWorkflowSource).toContain('prReviewsResolvedJob')
    expect(generatedWorkflowSource).toContain('[prReviewsResolvedJobId]: prReviewsResolvedJob()')
    expect(generatedCiWorkflowYamlSource).toContain('  pr-reviews-resolved:')
    expect(generatedCiWorkflowYamlSource).toContain('reviewThreads(first:100')
    expect(generatedRepoSettingsSource).toContain('prReviewsPullRequestRule()')
  })
  it('requires thread resolution natively and as a visible CI check', () => {
    const pullRequestRule = generatedRepoSettings.rules.find((rule) => rule.type === 'pull_request')
    expect(pullRequestRule?.parameters?.required_review_thread_resolution).toBe(true)
    expect(generatedRepoSettingsSource).toContain('prReviewsPullRequestRule()')
    expect(generatedRequiredCheckContexts.includes('pr-reviews-resolved')).toBe(true)
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

  it('provides cachix CLI from /nix/store on PATH instead of mutating the runner nix profile', () => {
    expect(ciWorkflowSource).toContain('export const cachixCliBuildStep')
    expect(ciWorkflowSource).toContain('nix build --no-link --print-out-paths nixpkgs#cachix')
    expect(ciWorkflowSource).toContain('echo "$out/bin" >> "$GITHUB_PATH"')
  })

  it('keeps cachixStep free of installCommand so cachix-action short-circuits via PATH', () => {
    const cachixStepSource = extractSourceBlock(ciWorkflowSource, 'export const cachixStep', '})\n')
    expect(cachixStepSource).not.toContain('installCommand')
    expect(cachixStepSource).not.toContain('nix profile install')
  })

  it('uses first-party Nix-packaged provider CLIs instead of runtime npm execution', () => {
    expect(netlifyTaskModuleSource).toContain('/nix/provider-clis/netlify-cli')
    expect(netlifyTaskModuleSource).toContain('netlifyBin ? null')
    expect(netlifyTaskModuleSource).not.toContain('pkgs.netlify-cli')
    expect(netlifyTaskModuleSource).not.toContain('bunx netlify-cli@24.11.3')
    expect(vercelTaskModuleSource).toContain('/nix/provider-clis/vercel-cli')
    expect(vercelTaskModuleSource).toContain('vercelCliPkg ? null')
    expect(vercelTaskModuleSource).not.toContain('bunx vercel')
    expect(generatedWorkflowSource).toContain('.#netlify-cli')
    expect(generatedWorkflowSource).toContain('.#vercel-cli')
    expect(generatedWorkflowSource).not.toContain('nixpkgs#netlify-cli')
    expect(generatedWorkflowSource).not.toContain('bunx vercel')
  })

  it('lets Vercel deploy jobs decorate the deploy run step', () => {
    expect(ciWorkflowSource).toContain('deployStepDecorator?: (')
    expect(ciWorkflowSource).toContain('project: VercelProject')
    expect(vercelDeploySource).toContain('opts.deployStepDecorator?.(')
    expect(vercelDeploySource).toContain(
      'vercelDeployStep({ project, runDevenvTasksBefore: opts.runDevenvTasksBefore })',
    )
  })

  it('does not require a Netlify workflow report on manual runs that do not deploy', () => {
    expect(netlifyDeploySource).toContain('deploy_ran=0')
    expect(netlifyDeploySource).toContain(
      'if [ "$deploy_ran" = "1" ] && [ ! -s "$workflow_report_path" ]; then',
    )
    expect(netlifyDeploySource).toContain(
      'echo "workflow_report_path=$workflow_report_path" >> "$GITHUB_OUTPUT"',
    )
  })
})

describe('ci workflow standard job helpers', () => {
  it.each([
    ['private', '0'],
    ['public', '1'],
  ] as const)(
    'renders the %s repository cache trust tier without an ambient GitHub token',
    (trustTier, publicReadOnly) => {
      const fixture = spawnSync(
        'bun',
        [
          '-e',
          `
            import {
              cachixCliBuildStep,
              compareCiMeasurementsStep,
              ciWorkflow,
              devenvTaskStep,
              downloadPreviousGitHubArtifactStep,
              githubTokenEnv,
              netlifyDeployStep,
              prSnapshotPackJob,
              standardCIEnv,
              vercelDeployJobs,
              vercelDeployStep,
            } from './genie/ci-workflow.ts'
            import { readFileSync } from 'node:fs'
            const generatedWorkflow = Bun.YAML.parse(
              readFileSync('.github/workflows/ci.yml', 'utf8'),
            )
            const nativeDependencyPolicyRegressionStep = generatedWorkflow.jobs[
              'quality'
            ].steps.find(
              (step) => step.name === 'CI runtime and native dependency policy regression checks',
            )
            const generatedSteps = Object.entries(generatedWorkflow.jobs).flatMap(
              ([jobId, job]) =>
                (job.steps ?? []).map((step) => ({ jobId, step })),
            )
            const expectedGitHubToken = '$' + '{{ github.token }}'
            const devenvRunMarker = '$' + '{DEVENV_BIN:?DEVENV_BIN not set}'
            const generatedDevenvAuthMissing = generatedSteps
              .filter(({ step }) => {
                const run = typeof step.run === 'string' ? step.run : ''
                return run.includes(devenvRunMarker)
              })
              .filter(({ step }) => step.env?.GITHUB_TOKEN !== expectedGitHubToken)
              .map(({ jobId, step }) => jobId + ': ' + step.name)
            const netlifyStep = netlifyDeployStep({
              NETLIFY_AUTH_TOKEN: 'netlify-secret',
            })
            const customNetlifyStep = netlifyDeployStep({
              GITHUB_TOKEN: 'netlify-app-token',
            })
            const vercelStep = vercelDeployStep({ name: 'docs' })
            const vercelJobs = vercelDeployJobs({
              projects: [{ name: 'docs', projectIdEnv: 'VERCEL_PROJECT_ID_DOCS' }],
              runner: ['ubuntu-latest'],
              baseSteps: [],
              env: {
                GITHUB_TOKEN: 'vercel-job-app-token',
                VERCEL_TEAM_ID: 'vercel-team',
              },
              includeComment: false,
              deployStepDecorator: (step) => ({
                ...step,
                env: { ...(step.env ?? {}), VERCEL_AUTH_TOKEN: 'vercel-secret' },
              }),
            })
            const vercelJob = vercelJobs['deploy-docs']
            const vercelJobStep = vercelJob.steps.find(
              (step) => step.name === 'Deploy docs to Vercel',
            )
            const decoratedVercelJobs = vercelDeployJobs({
              projects: [{ name: 'docs', projectIdEnv: 'VERCEL_PROJECT_ID_DOCS' }],
              runner: ['ubuntu-latest'],
              baseSteps: [],
              env: { GITHUB_TOKEN: 'vercel-job-app-token' },
              includeComment: false,
              deployStepDecorator: (step) => ({
                ...step,
                env: { ...(step.env ?? {}), GITHUB_TOKEN: 'vercel-decorator-app-token' },
              }),
            })
            const decoratedVercelJob = decoratedVercelJobs['deploy-docs']
            const decoratedVercelJobStep = decoratedVercelJob.steps.find(
              (step) => step.name === 'Deploy docs to Vercel',
            )
            const snapshotPackStep = prSnapshotPackJob({
              topologyPath: 'release-topology.json',
              setupStepsAfterCheckout: [],
              packTask: 'release:pack',
            })['pack-pr-snapshot'].steps.find((step) => step.name === 'Pack exact-SHA snapshot')
            const directNixAuthMissing = generatedSteps
              .filter(({ step }) => {
                const run = typeof step.run === 'string' ? step.run : ''
                return (
                  run.includes('nix build') ||
                  run.includes('nix run') ||
                  run.includes('require_ci_measurement_tool')
                )
              })
              .filter(({ step }) => step.env?.GITHUB_TOKEN !== expectedGitHubToken)
              .map(({ jobId, step }) => jobId + ': ' + step.name)
            const scriptBackedNixStepNames = [
              'Resolve devenv',
              'Bootstrap cold-proof (R32)',
              'CI runtime and native dependency policy regression checks',
              'Downstream flake-input regression',
            ]
            const scriptBackedNixAuthMissing = generatedSteps
              .filter(({ step }) => scriptBackedNixStepNames.includes(step.name))
              .filter(({ step }) => step.env?.GITHUB_TOKEN !== expectedGitHubToken)
              .map(({ jobId, step }) => jobId + ': ' + step.name)
            const sourceShapeStep = generatedSteps.find(
              ({ step }) => step.name === 'Measure source shape: effect-utils',
            )?.step
            const localOnlyStepTokenPresence = Object.fromEntries(
              ['Reject tracked product and editor payload bytes'].map((name) => {
                const step = generatedSteps.find(({ step }) => step.name === name)?.step
                if (step === undefined) {
                  throw new Error('missing generated local-only step: ' + name)
                }
                return [name, Object.hasOwn(step.env ?? {}, 'GITHUB_TOKEN')]
              }),
            )
            const trustTier = ${JSON.stringify(trustTier)}
            const workflow = ciWorkflow({
              actionlint: false,
              trustTier,
              name: 'CI',
              on: { push: { branches: ['main'] } },
              jobs: { check: { 'runs-on': 'ubuntu-latest', steps: [] } },
            })
            console.log(JSON.stringify({
              jobEnv: workflow.data.jobs.check?.env,
              standardEnv: standardCIEnv({ trustTier }),
              githubTokenEnv: githubTokenEnv(),
              nixStepEnv: cachixCliBuildStep.env,
              devenvStepEnv: devenvTaskStep('Check', 'check:quick').env,
              ghStepEnv: downloadPreviousGitHubArtifactStep({
                artifactName: 'baseline',
                outputDir: 'tmp/baseline',
              }).env.GITHUB_TOKEN,
              nativeDependencyPolicyRegressionStepEnv: nativeDependencyPolicyRegressionStep.env,
              sourceShapeStepEnv: sourceShapeStep?.env,
              generatedDevenvAuthMissing,
              netlifyStepEnv: netlifyStep.env,
              customNetlifyStepEnv: customNetlifyStep.env,
              vercelStepEnv: vercelStep.env,
              vercelJobHasToken: Object.hasOwn(vercelJob.env, 'GITHUB_TOKEN'),
              vercelJobTeamId: vercelJob.env.VERCEL_TEAM_ID,
              vercelJobStepEnv: vercelJobStep?.env,
              decoratedVercelJobStepEnv: decoratedVercelJobStep?.env,
              decoratedVercelJobHasToken: Object.hasOwn(
                decoratedVercelJob.env,
                'GITHUB_TOKEN',
              ),
              snapshotPackStepEnv: snapshotPackStep?.env,
              directNixAuthMissing,
              scriptBackedNixAuthMissing,
              localOnlyStepTokenPresence,
              comparisonHasToken: Object.hasOwn(
                compareCiMeasurementsStep().env,
                'GITHUB_TOKEN',
              ),
              disabledComparisonHasToken: Object.hasOwn(
                compareCiMeasurementsStep({ prComment: { enabled: false } }).env,
                'GITHUB_TOKEN',
              ),
              commentComparisonTokens: (() => {
                const env = compareCiMeasurementsStep({ prComment: { enabled: true } }).env
                return { GITHUB_TOKEN: env.GITHUB_TOKEN, GH_TOKEN: env.GH_TOKEN }
              })(),
              customCommentComparisonTokens: (() => {
                const env = compareCiMeasurementsStep({
                  prComment: { enabled: true, tokenExpression: 'custom-token' },
                }).env
                return { GITHUB_TOKEN: env.GITHUB_TOKEN, GH_TOKEN: env.GH_TOKEN }
              })(),
            }))
          `,
        ],
        { cwd: ciWorkflowModuleRoot, encoding: 'utf8' },
      )
      const expectedEnv = {
        FORCE_SETUP: '1',
        CI: 'true',
        BUCK2_NO_REMOTE_CACHE: '0',
        BUCK2_PUBLIC_CACHE_READ_ONLY: publicReadOnly,
      }
      const expectedTokenEnv = {
        GITHUB_TOKEN: '${{ github.token }}',
      }

      expect(fixture.status, fixture.stderr).toBe(0)
      expect(JSON.parse(fixture.stdout)).toEqual({
        jobEnv: expectedEnv,
        standardEnv: expectedEnv,
        githubTokenEnv: expectedTokenEnv,
        nixStepEnv: expectedTokenEnv,
        devenvStepEnv: expectedTokenEnv,
        ghStepEnv: '${{ github.token }}',
        nativeDependencyPolicyRegressionStepEnv: expectedTokenEnv,
        sourceShapeStepEnv: {
          ARTIFACT_DIR: 'tmp/source-shape-ci/current/effect-utils',
          RUNNER_CLASS: '${{ runner.os }}-${{ runner.arch }}',
          ...expectedTokenEnv,
        },
        generatedDevenvAuthMissing: [],
        netlifyStepEnv: {
          NETLIFY_AUTH_TOKEN: 'netlify-secret',
          ...expectedTokenEnv,
        },
        customNetlifyStepEnv: {
          GITHUB_TOKEN: 'netlify-app-token',
        },
        vercelStepEnv: expectedTokenEnv,
        vercelJobHasToken: false,
        vercelJobTeamId: 'vercel-team',
        vercelJobStepEnv: {
          GITHUB_TOKEN: 'vercel-job-app-token',
          VERCEL_AUTH_TOKEN: 'vercel-secret',
        },
        decoratedVercelJobStepEnv: {
          GITHUB_TOKEN: 'vercel-decorator-app-token',
        },
        decoratedVercelJobHasToken: false,
        snapshotPackStepEnv: {
          GIT_SHA: '${{ github.event.pull_request.head.sha }}',
          PR_NUMBER: '${{ github.event.pull_request.number }}',
          ...expectedTokenEnv,
        },
        directNixAuthMissing: [],
        scriptBackedNixAuthMissing: [],
        localOnlyStepTokenPresence: {
          'Reject tracked product and editor payload bytes': false,
        },
        comparisonHasToken: false,
        disabledComparisonHasToken: false,
        commentComparisonTokens: {
          GITHUB_TOKEN: '${{ github.token }}',
          GH_TOKEN: '${{ github.token }}',
        },
        customCommentComparisonTokens: {
          GITHUB_TOKEN: 'custom-token',
          GH_TOKEN: 'custom-token',
        },
      })
    },
  )

  it('fails Netlify PR previews on rejected credentials while tolerating absent fork secrets', () => {
    const fixture = spawnSync(
      'bun',
      [
        '-e',
        `
          import { netlifyDeployStep } from './genie/ci-workflow.ts'
          const run = netlifyDeployStep({ NETLIFY_AUTH_TOKEN: 'netlify-secret' }).run
          const policies = Object.fromEntries(
            run
              .split('\\n')
              .filter((line) => line.includes('netlify:deploy'))
              .map((line) => {
                const inputs = [...line.matchAll(/--input ([A-Za-z]+)=(\\S+)/g)].map(
                  ([, key, value]) => [key, value],
                )
                const byKey = Object.fromEntries(inputs)
                return [
                  byKey.type,
                  Object.fromEntries(inputs.filter(([key]) => key.endsWith('Policy'))),
                ]
              }),
          )
          console.log(JSON.stringify(policies))
        `,
      ],
      { cwd: ciWorkflowModuleRoot, encoding: 'utf8' },
    )

    expect(fixture.status, fixture.stderr).toBe(0)
    expect(JSON.parse(fixture.stdout)).toEqual({
      prod: { missingAuthPolicy: 'skip' },
      pr: { missingAuthPolicy: 'skip' },
    })
  })

  it('centralizes self-hosted devenv task job composition', () => {
    expect(ciWorkflowSource).toContain('export const devenvTaskStep')
    expect(ciWorkflowSource).toContain('export const standardSelfHostedDevenvTaskJob')
    expect(ciWorkflowSource).toContain('standardSelfHostedPnpmCiPrepSteps(prep)')
    expect(ciWorkflowSource).toContain('standardSelfHostedPnpmCiPostSteps(post)')
  })
})

describe('storybook preview split build/deploy', () => {
  let facts: ReturnType<typeof JSON.parse>

  beforeAll(() => {
    const fixture = spawnSync(
      'bun',
      [
        '-e',
        `
          import { readFileSync } from 'node:fs'
          import { netlifyPreviewDeployJobs } from './genie/ci-workflow.ts'
          const parse = (file) => Bun.YAML.parse(readFileSync('.github/workflows/' + file, 'utf8'))
          const build = parse('storybook-preview-build.yml')
          const deploy = parse('storybook-preview-deploy.yml')
          const stepsOf = (workflow) =>
            Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
              (job.steps ?? []).map((step) => ({ jobId, step })),
            )
          const secretRefs = (workflow) =>
            Object.entries(workflow.jobs).flatMap(([jobId, job]) => {
              const { steps = [], ...jobRest } = job
              return [
                ...(JSON.stringify(jobRest).includes('secrets.') ? [{ jobId, scope: 'job' }] : []),
                ...steps.flatMap((step) =>
                  Object.entries(step.env ?? {})
                    .filter(([, value]) => String(value).includes('secrets.'))
                    .map(([key]) => ({ jobId, step: step.id ?? step.name, key })),
                ),
                ...steps
                  .filter((step) => JSON.stringify({ ...step, env: undefined }).includes('secrets.'))
                  .map((step) => ({ jobId, step: step.id ?? step.name, scope: 'non-env' })),
              ]
            }).concat(
              JSON.stringify({ ...workflow, jobs: undefined }).includes('secrets.')
                ? [{ scope: 'workflow' }]
                : [],
            )
          const resolveStep = deploy.jobs['resolve-preview'].steps.find((s) => s.id === 'pull-request')
          const deployStep = deploy.jobs['deploy-preview'].steps.find((s) => s.id === 'deploy')
          const stagedRun = netlifyPreviewDeployJobs({
            runsOn: 'runner',
            setupSteps: [],
            netlifyAuthToken: 'token',
            title: 't',
            noRecordsMessage: 'n',
            stateId: 's',
          })['deploy-preview'].steps.find((s) => s.id === 'deploy').run
          console.log(JSON.stringify({
            buildName: build.name,
            buildTriggers: Object.keys(build.on),
            buildSecretRefs: secretRefs(build),
            buildUsesStage: stepsOf(build).some(({ step }) => String(step.run ?? '').includes('netlify:stage')),
            buildUploads: stepsOf(build).some(({ step }) => String(step.uses ?? '').startsWith('actions/upload-artifact@')),
            buildUploadIncludesHidden: stepsOf(build).some(({ step }) => String(step.uses ?? '').startsWith('actions/upload-artifact@') && step.with?.['include-hidden-files'] === true),
            deployTriggers: deploy.on,
            resolveIf: deploy.jobs['resolve-preview'].if,
            deployNeeds: deploy.jobs['deploy-preview'].needs,
            deployIf: deploy.jobs['deploy-preview'].if,
            resolveEnv: resolveStep.env,
            deployStepEnvKeys: Object.keys(deployStep.env).sort(),
            deployPr: deployStep.env.NETLIFY_PREVIEW_PR,
            deploySecretRefs: secretRefs(deploy),
            permissions: Object.fromEntries(
              Object.entries(deploy.jobs).map(([jobId, job]) => [jobId, job.permissions]),
            ),
            workflowPermissions: deploy.permissions,
            checkoutRefs: stepsOf(deploy)
              .filter(({ step }) => String(step.uses ?? '').startsWith('actions/checkout@'))
              .map(({ step }) => step.with?.ref),
            downloadRunIds: stepsOf(deploy)
              .filter(({ jobId, step }) => jobId === 'deploy-preview' && String(step.uses ?? '').startsWith('actions/download-artifact@'))
              .map(({ step }) => step.with['run-id']),
            deployReadsPullRequestEvent: JSON.stringify(deploy).includes('github.event.pull_request'),
            headRefJobs: Object.entries(deploy.jobs)
              .filter(([, job]) => /workflow_run\\.head_(sha|branch|repository)|pull_request\\.head/.test(JSON.stringify(job)))
              .map(([jobId]) => jobId),
            stagedTaskNames: [...stagedRun.matchAll(/devenv tasks run (\\S+)/g)].map(([, task]) => task),
            stagedDeployPolicies: [
              ...new Set(
                [...stagedRun.matchAll(/--input "?([A-Za-z]+Policy)=(\\w+)/g)].map(([, k, v]) => k + '=' + v),
              ),
            ],
          }))
        `,
      ],
      { cwd: ciWorkflowModuleRoot, encoding: 'utf8' },
    )
    expect(fixture.status, fixture.stderr).toBe(0)
    facts = JSON.parse(fixture.stdout)
  })

  it('builds PR previews in an uncredentialed pull_request job', () => {
    expect(facts.buildTriggers).toEqual(['pull_request'])
    expect(facts.buildSecretRefs).toEqual([])
    expect(facts.buildUsesStage).toBe(true)
    expect(facts.buildUploads).toBe(true)
    expect(facts.buildUploadIncludesHidden).toBe(true)
  })

  it('deploys only from a successful pull_request run of the build workflow', () => {
    expect(facts.deployTriggers).toEqual({
      workflow_run: { workflows: [facts.buildName], types: ['completed'] },
    })
    expect(facts.resolveIf).toContain("github.event.workflow_run.conclusion == 'success'")
    expect(facts.resolveIf).toContain("github.event.workflow_run.event == 'pull_request'")
    expect(facts.deployNeeds).toEqual(['resolve-preview'])
    expect(facts.deployIf).toBe("${{ needs.resolve-preview.outputs.deploy == 'true' }}")
  })

  it('derives PR identity from the workflow_run payload, never the PR checkout or artifact', () => {
    expect(facts.resolveEnv).toMatchObject({
      RUN_PR_NUMBER: '${{ github.event.workflow_run.pull_requests[0].number }}',
      RUN_HEAD_SHA: '${{ github.event.workflow_run.head_sha }}',
      RUN_HEAD_REPO: '${{ github.event.workflow_run.head_repository.full_name }}',
      RUN_CONCLUSION: '${{ github.event.workflow_run.conclusion }}',
    })
    expect(facts.deployPr).toBe('${{ needs.resolve-preview.outputs.number }}')
    expect(facts.deployReadsPullRequestEvent).toBe(false)
    expect(facts.checkoutRefs).toEqual(['${{ github.workflow_sha }}', '${{ github.workflow_sha }}'])
    expect(facts.downloadRunIds).toEqual(['${{ github.event.workflow_run.id }}'])
  })

  it('scopes the Netlify token to the deploy step and PR writes to the comment job', () => {
    expect(facts.deploySecretRefs).toEqual([
      { jobId: 'deploy-preview', step: 'deploy', key: 'NETLIFY_AUTH_TOKEN' },
    ])
    expect(facts.deployStepEnvKeys).toEqual([
      'GITHUB_TOKEN',
      'NETLIFY_AUTH_TOKEN',
      'NETLIFY_PREVIEW_PR',
      'NETLIFY_STAGE_DIR',
    ])
    expect(facts.workflowPermissions).toEqual({})
    expect(facts.permissions).toEqual({
      'resolve-preview': { 'pull-requests': 'read' },
      'deploy-preview': { actions: 'read', contents: 'read', 'pull-requests': 'read' },
      'publish-preview-comment': { contents: 'read', 'pull-requests': 'write' },
    })
  })

  it('keeps rejected Netlify credentials fatal for staged PR previews', () => {
    expect(facts.stagedDeployPolicies).toEqual(['missingAuthPolicy=skip'])
  })

  it('never evaluates the PR head: only payload resolution reads head refs', () => {
    expect(facts.headRefJobs).toEqual(['resolve-preview'])
  })

  it('deploys the staged directories as data through one task, not per configured target', () => {
    expect([...new Set(facts.stagedTaskNames)]).toEqual(['netlify:deploy-staged'])
  })

  describe('staged target validation', () => {
    const script = join(
      ciWorkflowModuleRoot,
      'nix/devenv-modules/tasks/shared/netlify-staged-targets.sh',
    )
    const listTargets = (stageDir: string, ...extra: string[]) =>
      spawnSync('bash', [script, stageDir, ...extra], { encoding: 'utf8' })
    const withStage = (entries: (stageDir: string) => void, run: (stageDir: string) => void) => {
      const stageDir = mkdtempSync(join(tmpdir(), 'netlify-stage-'))
      try {
        entries(stageDir)
        run(stageDir)
      } finally {
        rmSync(stageDir, { recursive: true, force: true })
      }
    }

    it('admits only alias-safe slugs', () => {
      const names = [
        'brand-new-pkg',
        'a',
        '0x',
        'a'.repeat(63),
        'a'.repeat(64),
        '../x',
        '..',
        '.',
        '.hidden',
        'a b',
        'a/b',
        '-leading',
        'Upper',
        'under_score',
        'dot.ted',
        'new\nline',
        '',
      ]
      const result = spawnSync(
        'bash',
        [
          '-c',
          'source "$1"; shift; for name in "$@"; do if netlify_staged_target_name_is_valid "$name"; then printf "1"; else printf "0"; fi; done',
          'netlify-staged-target-names',
          script,
          ...names,
        ],
        { encoding: 'utf8' },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(Object.fromEntries(names.map((name, i) => [name, result.stdout[i] === '1']))).toEqual({
        'brand-new-pkg': true,
        a: true,
        '0x': true,
        ['a'.repeat(63)]: true,
        ['a'.repeat(64)]: false,
        '../x': false,
        '..': false,
        '.': false,
        '.hidden': false,
        'a b': false,
        'a/b': false,
        '-leading': false,
        Upper: false,
        under_score: false,
        'dot.ted': false,
        'new\nline': false,
        '': false,
      })
    })

    it('lists every valid staged directory, including names no revision configures', () => {
      withStage(
        (stageDir) => {
          for (const name of ['storybook', 'brand-new-pkg']) mkdirSync(join(stageDir, name))
        },
        (stageDir) => {
          const result = listTargets(stageDir)
          expect(result.status, result.stderr).toBe(0)
          expect(result.stdout).toBe('brand-new-pkg\nstorybook\n')
        },
      )
    })

    it.each([
      ['dot directory', (stageDir: string) => mkdirSync(join(stageDir, '.hidden')), '.hidden'],
      ['name with a space', (stageDir: string) => mkdirSync(join(stageDir, 'a b')), 'a\\ b'],
      [
        'symlinked directory',
        (stageDir: string) => symlinkSync(tmpdir(), join(stageDir, 'linked')),
        'linked (symlink)',
      ],
      [
        'regular file',
        (stageDir: string) => writeFileSync(join(stageDir, 'file'), ''),
        'file (not a directory)',
      ],
    ] as const)('rejects the whole stage when it contains a %s', (_label, addHostile, reported) => {
      withStage(
        (stageDir) => {
          mkdirSync(join(stageDir, 'storybook'))
          addHostile(stageDir)
        },
        (stageDir) => {
          const result = listTargets(stageDir)
          expect(result.status).toBe(1)
          expect(result.stdout).toBe('')
          expect(result.stderr).toContain(reported)
        },
      )
    })

    it('rejects an empty stage, a symlinked stage, and more targets than the cap', () => {
      withStage(
        () => {},
        (stageDir) => {
          expect(listTargets(stageDir).status).toBe(1)
          const linkedStage = `${stageDir}-link`
          symlinkSync(stageDir, linkedStage)
          try {
            mkdirSync(join(stageDir, 'storybook'))
            expect(listTargets(linkedStage).status).toBe(1)
          } finally {
            rmSync(linkedStage, { force: true })
          }
          for (const name of ['a', 'b', 'c']) mkdirSync(join(stageDir, name))
          expect(listTargets(stageDir, '4').status).toBe(0)
          const capped = listTargets(stageDir, '3')
          expect(capped.status).toBe(1)
          expect(capped.stderr).toContain('at most 3')
        },
      )
    })
  })
})

describe('ci workflow devenv perf helpers', () => {
  it('exposes reusable devenv perf CI job helpers', () => {
    expect(ciWorkflowSource).toContain('export const devenvPerfJob')
    expect(ciWorkflowSource).toContain('export const devenvPerfBenchmarkStep')
    expect(ciWorkflowSource).toContain('export const devenvPerfArtifactStep')
    expect(ciWorkflowSource).toContain('export type CiMeasurementDescriptor')
    expect(ciWorkflowSource).toContain('export type DevenvPerfProbe')
    expect(ciWorkflowSource).toContain('export type DevenvPerfTaskProbe')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementStep')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementSteps')
    expect(ciWorkflowSource).toContain('export const nixClosureMeasurementsJob')
    expect(ciWorkflowSource).toContain('export const defaultNixClosureMeasurementBuckets')
    expect(ciWorkflowSource).toContain('export type NixClosureMeasurementBucket')
    expect(ciWorkflowSource).toContain('export type NixClosureMeasurementTarget')
  })

  it('emits the standard warm shell and task-list probes with native trace artifacts', () => {
    expect(generatedCiWorkflowYamlSource).toContain('devenv-perf:')
    expect(generatedCiWorkflowYamlSource).toContain('OTEL_SERVICE_NAME: devenv-perf-ci')
    expect(generatedCiWorkflowYamlSource).toContain(
      "measure 'shell_eval_traced' 'Shell eval with OTEL trace' 'devenv shell' 'Evaluates the dev shell with native devenv JSON tracing enabled.' '$ARTIFACT_DIR/traces/shell_eval_traced.json' '0' '1'",
    )
    expect(generatedCiWorkflowYamlSource).toContain('--trace-to')
    expect(generatedCiWorkflowYamlSource).toContain('json:file:$trace_file')
    expect(generatedCiWorkflowYamlSource).toContain('$ARTIFACT_DIR/traces/shell_eval_traced.json')
    expect(generatedCiWorkflowYamlSource).toContain(
      `paired_baseline_enabled="$(jq -r 'if .enabled == true then 1 else 0 end' <<<"$gate_policy")"`,
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      `if [ "$phase" = "warmup" ] && [ "$CI_MEASUREMENT_PAIRED_ENABLED" -eq 1 ] && [ "$paired_baseline_enabled" -eq 1 ]; then`,
    )
    expect(generatedCiWorkflowYamlSource).toContain('subject:"base",phase:"warmup",status:$status')
    expect(generatedDevenvPerfJob).toContain('timeout-minutes: 90')
    expect(generatedDevenvPerfJob).toContain('nscloud-ubuntu-24.04-amd64-16x64-with-features')
    expect(generatedCiWorkflowYamlSource).toContain("measure 'shell_eval_warm' 'Warm shell eval'")
    expect(generatedCiWorkflowYamlSource).toContain("measure 'tasks_list' 'devenv tasks list'")
    expect(generatedCiWorkflowYamlSource).toContain(
      "'Loads the devenv processes command help path.' '' '1' '9'",
    )
  })

  it('writes a stable summary artifact for regression tracking', () => {
    expect(generatedCiWorkflowYamlSource).toContain('schemaVersion: $schemaVersion')
    expect(generatedCiWorkflowYamlSource).toContain('checks: ($timings[0] | map')
    expect(generatedCiWorkflowYamlSource).toContain('measurements.json')
    expect(generatedCiWorkflowYamlSource).toContain('--argjson schemaVersion 1')
    expect(generatedCiWorkflowYamlSource).toContain('effect-utils-ci-measurement')
    expect(generatedCiWorkflowYamlSource).toContain('devenv." + .id + ".duration')
    expect(generatedCiWorkflowYamlSource).toContain(
      'target: { kind: "devenv", id: "dev-shell", name: "dev-shell", label: "Dev shell", group: "devenv", system: $targetSystem }',
    )
    expect(generatedCiWorkflowYamlSource).toContain('probeLabel: .label')
    expect(generatedCiWorkflowYamlSource).toContain('sampleCount: (.statistics.sampleCount // 1)')
    expect(generatedCiWorkflowYamlSource).toContain(
      '| Probe | Runs | Head total | Base total | Head median | Paired delta | Measured share |',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'map([.samples[]?.durationMs] | add // 0) | add',
    )
    expect(generatedCiWorkflowYamlSource).toContain('baselineSources')
    expect(generatedCiWorkflowYamlSource).toContain('low_baseline_count')
    expect(generatedCiWorkflowYamlSource).toContain('low_current_sample_count')
    expect(generatedCiWorkflowYamlSource).toContain('low_paired_sample_count')
    expect(generatedCiWorkflowYamlSource).toContain('readiness:$readiness')
    expect(generatedCiWorkflowYamlSource).toContain(
      'enforceable: (.enabledCount == .gateableCount)',
    )
    expect(generatedCiWorkflowYamlSource).toContain('within_baseline_range')
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif $needsHistoricalBaselineCount and $baselineSources < ($policy.minBaselineSources // 1) then "low_baseline_count"',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif $currentSamples < ($policy.minCurrentSamples // 1) then "low_current_sample_count"',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'if ($gateable and $confidence == "threshold_exceeded") then $thresholdStatus',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'elif ($canUseRobustBandSuppression and $thresholdStatus != "pass" and $withinRobustBand) then "within_robust_band"',
    )
    expect(ciWorkflowSource).toContain("label: 'Needs more baseline'")
    expect(ciWorkflowSource).toContain("label: 'Needs repeat'")
    expect(ciWorkflowSource).toContain("label: 'Needs paired evidence'")
    expect(ciWorkflowSource).toContain("label: 'Too small to matter'")
    expect(ciWorkflowSource).toContain("label: 'Within noise band'")
    expect(ciWorkflowSource).toContain("label: 'Meaningfully lower'")
    expect(generatedCiWorkflowYamlSource).toContain('RUNNER_CLASS:')
    expect(generatedCiWorkflowYamlSource).toContain('namespace-profile-linux-x86-64')
    expect(ciWorkflowSource).toContain('nix.closure.nar_size')
    expect(ciWorkflowSource).toContain('nix.closure.path_count')
    expect(ciWorkflowSource).toContain('nix.closure.bucket.nar_size')
    expect(ciWorkflowSource).toContain('artifact_file=${artifactFileAssignment}')
    expect(ciWorkflowSource).not.toContain('artifact_file=${shellSingleQuote(artifactFile)}')
    expect(ciWorkflowSource).toContain(
      'target: { kind: "nix-closure", id: $targetId, name: $targetName, label: $targetLabel, group: $targetGroup, path: $targetPath, system: $targetSystem }',
    )
    expect(ciWorkflowSource).toContain(
      'topPaths: ($closurePaths | sort_by(.narSize) | reverse | .[:30])',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain('dev3')
    expect(generatedCiWorkflowYamlSource).not.toContain('perf-comparison.json')
    expect(generatedCiWorkflowYamlSource).not.toContain('DEVENV_PERF_REGRESSION_MODE')
    expect(generatedCiWorkflowYamlSource).toContain('devenv-perf-warm-median-v2')
    expect(generatedCiWorkflowYamlSource).toContain("CI_MEASUREMENT_PR_COMMENT_ENABLED: 'true'")
    expect(generatedCiWorkflowYamlSource).toContain(
      'CI_MEASUREMENT_PR_COMMENT_TITLE: CI Measurements',
    )
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_SEED_RUNS_JSON:')
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_REQUIRED_OBSERVATIONS_JSON:')
    expect(generatedCiWorkflowYamlSource).toContain('BASELINE_MAX_CANDIDATE_RUNS:')
    expect(generatedCiWorkflowYamlSource).toContain("measure 'task_check_quick_warm'")
    expect(generatedCiWorkflowYamlSource).toContain("measure 'task_check_quick_forced'")
    expect(generatedCiWorkflowYamlSource).not.toContain('"id":"devenv.task_check_quick.duration"')
    expect(ciWorkflowSource).toContain(
      'requiredObservations?: readonly CiMeasurementRequiredBaselineObservation[]',
    )
    expect(ciWorkflowSource).toContain('baselineMaxCandidateRuns?: number')
    expect(ciWorkflowSource).toContain('baseline_requirements_satisfied')
    expect(ciWorkflowSource).toContain('observationCounts: ($observationCounts[0] // null)')
    expect(generatedCiWorkflowYamlSource).toContain('"runId":"26085158592"')
    expect(generatedCiWorkflowYamlSource).toContain('"label":"main baseline"')
    expect(generatedCiWorkflowYamlSource).toContain('Upload devenv perf artifacts')
    expect(generatedCiWorkflowYamlSource).toContain('retention-days: 7')
    expect(generatedCiWorkflowYamlSource).toContain('retention-days: 14')
    expect(ciWorkflowSource).toContain("contents: 'write'")
    expect(ciWorkflowSource).toContain('seedRuns?: readonly CiMeasurementBaselineSeedRun[]')
    expect(ciWorkflowSource).toContain('seedRunIds?: readonly string[]')
    expect(ciWorkflowSource).toContain('baselineSeedRuns?: readonly CiMeasurementBaselineSeedRun[]')
    expect(ciWorkflowSource).toContain('baselineSeedRunIds?: readonly string[]')
    expect(ciWorkflowSource).not.toContain('measurement_pr_number:')
    expect(ciWorkflowSource).not.toContain('CI_MEASUREMENT_PR_COMMENT_PR_NUMBER')
    expect(ciWorkflowSource).toContain(
      'CI measurement PR comments are produced only by pull_request workflows',
    )
    expect(ciWorkflowSource).toContain('unable to publish required CI measurement PR comment')
    expect(ciWorkflowSource).toContain('seedRuns: ($seedRuns[0] // [])')
    expect(ciWorkflowSource).toContain('baselineProvenance: ($baselineProvenance[0] // null)')
    expect(ciWorkflowSource).toContain(
      '["devenvRev", "otelServiceName", "status", "probeLabel", "sampleCount", "measuredSampleCount"] | index($key) | not',
    )
    expect(ciWorkflowSource).toContain('chart_file="$comment_tmp_dir/perf-change-vs-baseline.svg"')
    expect(ciWorkflowSource).toContain(
      'chart_png_file="$comment_tmp_dir/perf-change-vs-baseline.png"',
    )
    expect(ciWorkflowSource).toContain(
      'chart_dark_png_file="$comment_tmp_dir/perf-change-vs-baseline-dark.png"',
    )
    expect(ciWorkflowSource).toContain(
      'No regressions. Comparable movement is below the semantic impact threshold; neutral rows are collapsed below.',
    )
    expect(generatedCiWorkflowYamlSource).toContain(
      'github.workflow }}-${{ github.event_name }}-${{ github.ref }}',
    )
    expect(generatedCiWorkflowYamlSource).not.toMatch(/^concurrency:/m)
    expect(generatedCiWorkflowYamlSource).toContain('concurrency:\n      group:')
    expect(ciWorkflowSource).toContain('export const ciJobConcurrency = ({ jobId, ...opts }:')
    expect(ciWorkflowSource).toContain("opts?.matrix === true ? '-${{ strategy.job-index }}' : ''")
    expect(ciWorkflowSource).toContain('const isMatrixJob = (job: GitHubWorkflowArgs')
    // Repository workflow sources are outside this package's hermetic compiler input.
    // Exercise their actual concurrency contract through the existing Bun probe boundary.
    const concurrencyProbe = spawnSync(
      process.env.BUN_BIN ?? 'bun',
      [
        '-e',
        `import workflow from './.github/workflows/ci.yml.genie.ts';
         console.log(JSON.stringify([
           workflow.data.jobs.test.concurrency,
           workflow.data.jobs['test-macos'].concurrency,
         ]));`,
      ],
      { cwd: ciWorkflowModuleRoot, encoding: 'utf8' },
    )
    expect(concurrencyProbe.status, concurrencyProbe.stderr).toBe(0)
    const [linuxConcurrency, darwinConcurrency] = JSON.parse(concurrencyProbe.stdout)
    expect(linuxConcurrency.group).toBeTypeOf('string')
    expect(darwinConcurrency.group).toBeTypeOf('string')
    expect(linuxConcurrency.group).not.toBe(darwinConcurrency.group)
    expect(generatedCiWorkflowYamlSource).toContain("format('measurement-baseline-{0}'")
    expect(generatedCiWorkflowYamlSource).not.toContain("format('measurement-pr-{0}-run-{1}'")
    expect(generatedCiWorkflowYamlSource).not.toContain('inputs.measurement_pr_number')
    expect(generatedCiWorkflowYamlSource).toContain("format('manual-run-{0}', github.run_id)")
    expect(ciWorkflowSource).toContain(
      '| What changed? | Group | Probe | Baseline -> current | Raw change | Impact | Confidence |',
    )
    expect(ciWorkflowSource).toContain('const semanticGroupLabel = (row) =>')
    expect(ciWorkflowSource).toContain('groupedScanTables(visibleNonZeroImpactRows)')
    expect(ciWorkflowSource).toContain(
      'const zeroImpactRows = actionableComparableRows.filter(isZeroImpactRow)',
    )
    expect(ciWorkflowSource).toContain('<summary>Unchanged / 0-impact measurements (')
    expect(ciWorkflowSource).toContain('<summary>Source-of-truth JSON</summary>')
    expect(ciWorkflowSource).toContain('const sourceOfTruth = {')
    expect(ciWorkflowSource).toContain('No non-zero actionable measurement impact detected.')
    expect(ciWorkflowSource).toContain('readiness <code>')
    expect(ciWorkflowSource).toContain('renderPerfChangeSvg')
    expect(ciWorkflowSource).toContain('Actionable measurement impact')
    expect(ciWorkflowSource).toContain(
      '0 means no actionable PR impact; 1x reaches the warning budget.',
    )
    expect(ciWorkflowSource).toContain('@media (prefers-color-scheme: dark)')
    expect(ciWorkflowSource).toContain('.chart-bg { fill: #0d1117; }')
    expect(ciWorkflowSource).toContain('<picture>')
    expect(ciWorkflowSource).toContain('<source media="(prefers-color-scheme: dark)"')
    expect(ciWorkflowSource).toContain('[SVG source]')
    expect(ciWorkflowSource).toContain('ensure_ci_measurement_tool resvg resvg')
    expect(ciWorkflowSource).toContain('nixpkgs#dejavu_fonts')
    expect(ciWorkflowSource).toContain('DejaVu Sans')
    expect(ciWorkflowSource).toContain('https://raw.githubusercontent.com')
    expect(ciWorkflowSource).toContain('repo_private="$(gh api "repos/$repo"')
    expect(ciWorkflowSource).toContain('if [ "$repo_private" = "true" ]; then')
    expect(ciWorkflowSource).toContain('CI_MEASUREMENT_PR_COMMENT_PUBLIC_ASSET_COMMAND')
    expect(ciWorkflowSource).toContain('bash -c "$public_asset_command" _ "$chart_png_file" png')
    expect(ciWorkflowSource).toContain(
      'bash -c "$public_asset_command" _ "$chart_dark_png_file" png',
    )
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_svg_path"')
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_png_path"')
    expect(ciWorkflowSource).toContain('gh api "repos/$repo/contents/$asset_dark_png_path"')
    expect(ciWorkflowSource).toContain('base64 <"$chart_file" | tr -d \'\\n\'')
    expect(ciWorkflowSource).toContain('base64 <"$chart_png_file" | tr -d \'\\n\'')
    expect(ciWorkflowSource).toContain(
      'nix path-info --recursive --closure-size --json "$out_path"',
    )
    expect(ciWorkflowSource).toContain('nix.closure.serialized_nar_size')
  })
})

describe('effect-utils standalone CI root', () => {
  it('runs every workflow lane from the actions checkout without composition plumbing', () => {
    expect(generatedCiWorkflowYamlSource).not.toContain('Prepare effect-utils composition')
    expect(generatedCiWorkflowYamlSource).not.toContain('Cleanup effect-utils composition')
    expect(generatedCiWorkflowYamlSource).not.toContain('prepare-effect-utils-composition.sh')
    expect(generatedCiWorkflowYamlSource).not.toContain('cleanup-effect-utils-composition.sh')
    expect(generatedCiWorkflowYamlSource).not.toContain('EFFECT_UTILS_MEMBER_ROOT')
    expect(generatedCiWorkflowYamlSource).not.toContain('EFFECT_UTILS_WORKSPACE_ROOT')
    expect(generatedCiWorkflowYamlSource).not.toContain('.megarepo/bin/buck2')
    expect(generatedCiWorkflowYamlSource).not.toMatch(/^\s+(?:buck2|\.\/[^ ]*buck2)\s/m)
  })

  it('keeps pull-request execution credentialless and trusted writes main-only', () => {
    expect(ciWorkflowSource).toContain("'persist-credentials': false")
    expect(generatedCiWorkflowYamlSource).toContain('permissions:\n  contents: read')
    for (const job of [
      'ci-measurements-report',
      'test-integration-notion',
      'test-live-deploy-ci-tools',
      'deploy-storybooks',
    ]) {
      const block =
        generatedCiWorkflowYamlSource.split(`  ${job}:\n`)[1]?.split(/^  [a-z]/m)[0] ?? ''
      expect(block, job).toContain("github.ref == 'refs/heads/main'")
    }
    for (const { event, ref, expected } of [
      { event: 'workflow_dispatch', ref: 'refs/heads/feature', expected: false },
      { event: 'workflow_dispatch', ref: 'refs/heads/main', expected: true },
      { event: 'push', ref: 'refs/heads/main', expected: true },
      { event: 'pull_request', ref: 'refs/heads/main', expected: false },
    ] as const) {
      const actual =
        ref === 'refs/heads/main' && (event === 'push' || event === 'workflow_dispatch')
      expect(actual).toBe(expected)
    }
  })

  it('keeps the Nix cache stable without projecting an ambient pnpm store', () => {
    expect(generatedCiWorkflowYamlSource).not.toContain(
      '${{ runner.temp }}/composition-state/pnpm-store-pure-v1',
    )
    expect(generatedCiWorkflowYamlSource).not.toContain(
      '${{ runner.temp }}/composition-state/${{ github.run_id }}',
    )
    expect(buckToolchainsSource).not.toContain('store_dir =')
    expect(generatedCiWorkflowYamlSource).not.toContain('Evict cached pnpm deps for oxlint-npm')
    expect(generatedCiWorkflowYamlSource).not.toContain('.#oxc-config-plugin-pnpm-deps')
  })
})
