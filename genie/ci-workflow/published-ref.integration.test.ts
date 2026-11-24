import { describe, expect, it } from 'bun:test'

import ciWorkflow from '../../.github/workflows/ci.yml.genie.ts'
import { createTestTempDirectoryFactory } from '../../scripts/test-tmp.ts'
import { publishedRefSteps } from './published-ref.ts'

const advanceStep = publishedRefSteps.find((step) => step.id === 'advance-published-ref')!
const makeTempDirectory = createTestTempDirectoryFactory()

it('manifest fixture cleanup cannot prompt for read-only cloned Git objects', async () => {
  const fixture = await Bun.file(new URL('./manifest-pr-decide.test.sh', import.meta.url)).text()
  expect(fixture).toContain('trap \'rm -rf -- "$tmp"\' EXIT')
})

/** Adapt only GitHub's git-data API to real local Git objects; run the producer unchanged. */
const runPromotion = (manifestChanged: boolean, script = advanceStep.run) =>
  Bun.spawnSync(
    [
      'bash',
      '-euo',
      'pipefail',
      '-c',
      [
        'fixture="$FIXTURE"',
        'export fixture',
        'source_root="$PWD"',
        'export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.com',
        'export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.com',
        'git init --bare "$fixture/remote.git" >&2',
        'git init "$fixture/work" >&2',
        'cd "$fixture/work"',
        'git remote add origin "$fixture/remote.git"',
        'mkdir -p nix/buck2-products genie/ci-workflow',
        'cp "$source_root/genie/ci-workflow/published-ref-decide.sh" genie/ci-workflow/',
        'printf \'{"version":1}\\n\' > nix/buck2-products/manifest.json',
        'git add .',
        'previous="$(git commit-tree "$(git write-tree)" -m Initial)"',
        'git update-ref HEAD "$previous"',
        'printf "candidate\\n" > candidate.txt',
        'git add candidate.txt',
        'export GITHUB_SHA="$(git commit-tree "$(git write-tree)" -p "$previous" -m Candidate)"',
        'git update-ref HEAD "$GITHUB_SHA"',
        'if [ "$MANIFEST_CHANGED" = true ]; then',
        '  printf \'{"version":2}\\n\' > nix/buck2-products/manifest.json',
        'fi',
        'export MANIFEST_BASE64_0="$(base64 -w0 nix/buck2-products/manifest.json)"',
        'export MANIFEST_BASE64_1= MANIFEST_BASE64_2= MANIFEST_BASE64_3=',
        'git add nix/buck2-products/manifest.json',
        'export SMOKED_TREE="$(git write-tree)"',
        'export RUNNER_TEMP="$fixture" GITHUB_STEP_SUMMARY="$fixture/summary"',
        'export GITHUB_REPOSITORY=example/repo',
        'gh() {',
        '  if [ "$*" = "auth setup-git" ]; then return; fi',
        '  local request blob tree message',
        '  request="$(cat)"',
        '  case "$*" in',
        '    *"/git/trees"*)',
        '      blob="$(jq -rj ".tree[0].content" <<< "$request" | git hash-object -w --stdin)"',
        '      GIT_INDEX_FILE="$fixture/index" git read-tree "$(jq -r .base_tree <<< "$request")"',
        '      GIT_INDEX_FILE="$fixture/index" git update-index --add --cacheinfo "100644,$blob,nix/buck2-products/manifest.json"',
        '      GIT_INDEX_FILE="$fixture/index" git write-tree',
        '      ;;',
        '    *"/git/commits"*)',
        '      tree="$(jq -r .tree <<< "$request")"',
        '      message="$(jq -r .message <<< "$request")"',
        '      git commit-tree "$tree" -p "$(jq -r ".parents[0]" <<< "$request")" -p "$(jq -r ".parents[1]" <<< "$request")" -m "$message"',
        '      ;;',
        '    *) return 1 ;;',
        '  esac',
        '}',
        // The local remote shares the same object database used by the API adapter.
        'rm -rf "$fixture/remote.git/objects"',
        'ln -s "$fixture/work/.git/objects" "$fixture/remote.git/objects"',
        'git --git-dir="$fixture/remote.git" update-ref refs/heads/published "$previous"',
        'git --git-dir="$fixture/remote.git" update-ref refs/heads/main "$GITHUB_SHA"',
        'export -f gh',
        'bash -euo pipefail -c "$ADVANCE_SCRIPT"',
        'published="$(git ls-remote origin refs/heads/published | cut -f1)"',
        'jq -n --arg previous "$previous" --arg candidate "$GITHUB_SHA" --arg published "$published" \\',
        '  --arg parents "$(git show -s --format=%P "$published")" \\',
        '  --arg subject "$(git show -s --format=%s "$published")" \\',
        '  --arg trailers "$(git show -s --format=%B "$published" | git interpret-trailers --parse)" \\',
        '  --arg changed "$(git diff --name-only "$GITHUB_SHA" "$published")" \\',
        '  --arg tree "$(git rev-parse "$published^{tree}")" --arg smoked "$SMOKED_TREE" \\',
        "  '{$previous, $candidate, $published, $parents, $subject, $trailers, $changed, $tree, $smoked}'",
      ].join('\n'),
    ],
    {
      stderr: 'pipe',
      env: {
        ...process.env,
        MANIFEST_CHANGED: String(manifestChanged),
        ADVANCE_SCRIPT: script,
        FIXTURE: makeTempDirectory('published-contract-'),
      },
    },
  )

describe('published commit consumer contract', () => {
  for (const manifestChanged of [true, false]) {
    it(`promotes the exact smoked tree with manifest changed=${manifestChanged}`, () => {
      const result = runPromotion(manifestChanged)
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      const commit = JSON.parse(result.stdout.toString())
      expect(commit.parents.split(' ')).toEqual([commit.previous, commit.candidate])
      expect(commit.subject).toBe(`Publish products for ${commit.candidate}`)
      expect(commit.trailers.split('\n')).toEqual([`Published-From: ${commit.candidate}`])
      expect(commit.changed).toBe(manifestChanged ? 'nix/buck2-products/manifest.json' : '')
      expect(commit.tree).toBe(commit.smoked)
      expect(commit.published).not.toBe(commit.previous)
    })
  }

  it('detects a producer mutant whose trailer differs from parent 2', () => {
    const mutant = advanceStep.run.replace(
      '\\n\\nPublished-From: " + $main',
      '\\n\\nPublished-From: " + $tip',
    )
    expect(mutant).not.toBe(advanceStep.run)
    const result = runPromotion(true, mutant)
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    const commit = JSON.parse(result.stdout.toString())
    expect(() =>
      expect(commit.trailers.split('\n')).toEqual([
        `Published-From: ${commit.parents.split(' ')[1]}`,
      ]),
    ).toThrow()
  })
})

const main = 'a'.repeat(40)
const later = 'b'.repeat(40)
const tip = 'c'.repeat(40)
const reportStep = publishedRefSteps.at(-1)!

/** Fake only the remote API boundary; execute the actual generated shell and trailer parser. */
const runReport = ({
  message = `Publish products\n\nPublished-From: ${main}`,
  comparison = { status: 'identical', behind_by: 0 },
  fail = '',
}: {
  message?: string
  comparison?: { status?: string; behind_by?: number }
  fail?: string
} = {}) =>
  Bun.spawnSync(
    [
      'bash',
      '-euo',
      'pipefail',
      '-c',
      [
        'gh() {',
        '  printf "CALL %s\\n" "$*" >&2',
        '  case "$*" in',
        '    *"--method POST"*)',
        '      if [ "$FAIL" = post ]; then return 1; fi',
        '      echo POSTED',
        '      ;;',
        '    *git/ref/heads/published*)',
        '      if [ "$FAIL" = ref ]; then return 1; fi',
        '      printf "%s" "$REF_JSON" | jq -r "${@: -1}"',
        '      ;;',
        '    *git/commits/*)',
        '      if [ "$FAIL" = commit ]; then return 1; fi',
        '      printf "%s" "$COMMIT_JSON" | jq -r "${@: -1}"',
        '      ;;',
        '    *compare/*)',
        '      if [ "$FAIL" = compare ]; then return 1; fi',
        '      printf "%s" "$COMPARE_JSON" | jq -r "${@: -1}"',
        '      ;;',
        '    *) return 1 ;;',
        '  esac',
        '}',
        reportStep.run,
      ].join('\n'),
    ],
    {
      stderr: 'pipe',
      env: {
        ...process.env,
        GITHUB_SHA: main,
        GITHUB_REPOSITORY: 'example/repo',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_RUN_ID: '123',
        REF_JSON: JSON.stringify({ object: { sha: tip } }),
        COMMIT_JSON: JSON.stringify({ message }),
        COMPARE_JSON: JSON.stringify(comparison),
        FAIL: fail,
      },
    },
  )

describe('promote-published verified status', () => {
  it('uses only contents:read and statuses:write, with reporting last and success-only', () => {
    const job = ciWorkflow.data.jobs['promote-published']!
    expect(job.permissions).toEqual({ contents: 'read', statuses: 'write' })
    expect(job.steps.at(-1)).toEqual(reportStep)
    expect(reportStep.id).toBe('report-verified-published-status')
    expect('if' in reportStep).toBe(false)
    expect(reportStep.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
  })

  for (const status of ['identical', 'ahead']) {
    it(`posts success after freshly verifying ${status}, including a later main/no-op`, () => {
      const result = runReport({
        message: `Publish products\n\nPublished-From: ${later}`,
        comparison: { status, behind_by: 0 },
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('POSTED')
      const calls = result.stderr.toString()
      expect(calls).toContain('git/ref/heads/published')
      expect(calls).toContain(`git/commits/${tip}`)
      expect(calls).toContain(`compare/${main}...${later}`)
      expect(calls.indexOf('compare/')).toBeLessThan(calls.indexOf('--method POST'))
      expect(calls).toContain(`statuses/${main}`)
      expect(calls).toContain('-f state=success -f context=published/current')
      expect(calls).toContain(
        '-f description=Published contains this main commit or a later main commit',
      )
      expect(calls).toContain('-f target_url=https://github.com/example/repo/actions/runs/123')
    })
  }

  for (const message of [
    'Missing trailer',
    'Publish products\n\nPublished-From: not-a-sha',
    `Publish products\n\nPublished-From: ${main}0`,
    `Publish products\n\nPublished-From: ${'g'.repeat(40)}`,
    `Publish products\n\nPublished-From: ${main}\nPublished-From: ${later}`,
    `Published-From: ${main}\n\nNot a trailer`,
  ]) {
    it(`warns without posting for invalid provenance: ${JSON.stringify(message)}`, () => {
      const result = runReport({ message })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('::warning::')
      expect(result.stderr.toString()).not.toContain('compare/')
      expect(result.stderr.toString()).not.toContain('--method POST')
    })
  }

  for (const comparison of [
    { status: 'behind', behind_by: 1 },
    { status: 'diverged', behind_by: 0 },
    { status: 'ahead', behind_by: 1 },
    { status: 'identical', behind_by: 1 },
    {},
  ]) {
    it(`warns without posting for unverified ancestry: ${JSON.stringify(comparison)}`, () => {
      const result = runReport({ comparison })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('::warning::')
      expect(result.stderr.toString()).not.toContain('--method POST')
    })
  }

  for (const fail of ['ref', 'commit', 'compare', 'post']) {
    it(`leaves ${fail} API failure to published-status without failing promotion`, () => {
      const result = runReport({ fail })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain('::warning::')
      expect(result.stdout.toString()).not.toContain('POSTED')
      if (fail !== 'post') expect(result.stderr.toString()).not.toContain('--method POST')
    })
  }
})
