import { describe, expect, it } from 'bun:test'

import { createTestTempDirectoryFactory } from '../../scripts/test-tmp.ts'

const makeTempDirectory = createTestTempDirectoryFactory()
const sha = 'a'.repeat(40)
const manifest = { filename: 'nix/buck2-products/manifest.json', status: 'modified' }
const proposal = {
  user: { login: 'overeng-nix-publisher[bot]', type: 'Bot' },
  head: { sha, repo: { full_name: 'example/repo' } },
  base: { ref: 'main', repo: { full_name: 'example/repo' } },
  draft: false,
  state: 'open',
  changed_files: 1,
}

/** Replace only GitHub's remote boundary; execute the production guard and jq. */
const run = ({
  pr = proposal,
  pages = [[manifest]],
  apiFailure = false,
  mergeFailure = false,
  pushedSha = sha,
}: {
  pr?: object
  pages?: readonly (readonly object[])[]
  apiFailure?: boolean
  mergeFailure?: boolean
  pushedSha?: string
} = {}) => {
  const result = Bun.spawnSync(
    [
      'bash',
      '-euo',
      'pipefail',
      '-c',
      [
        'source genie/ci-workflow/manifest-pr-enqueue.sh',
        'gh() {',
        '  test "$GH_TOKEN" = publisher-app-token || return 1',
        '  case "$*" in',
        '    "api --paginate --slurp repos/example/repo/pulls/123/files?per_page=100")',
        '      if [ "$API_FAILURE" = true ]; then return 1; fi',
        '      printf "%s" "$PAGES" ;;',
        '    "api repos/example/repo/pulls/123") printf "%s" "$PR" ;;',
        '    "pr merge 123 --repo example/repo --auto --match-head-commit $PUSHED_SHA")',
        '      test "$GH_PROMPT_DISABLED" = 1 || return 1',
        '      echo MERGE_REQUESTED',
        '      if [ "$MERGE_FAILURE" = true ]; then return 1; fi ;;',
        '    *) echo "Unexpected gh invocation: $*" >&2; return 1 ;;',
        '  esac',
        '}',
        'manifest_pr_enqueue example/repo 123 "$PUSHED_SHA"',
      ].join('\n'),
    ],
    {
      env: {
        ...process.env,
        GH_TOKEN: 'publisher-app-token',
        GITHUB_STEP_SUMMARY: `${makeTempDirectory('manifest-queue-')}/summary`,
        PR: JSON.stringify(pr),
        PAGES: JSON.stringify(pages),
        API_FAILURE: String(apiFailure),
        MERGE_FAILURE: String(mergeFailure),
        PUSHED_SHA: pushedSha,
      },
    },
  )
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

describe('publisher manifest merge queue', () => {
  it('requests queue entry at the exact pushed SHA using the app token', () => {
    const result = run()
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('MERGE_REQUESTED')
    expect(result.stderr).toContain('pending requirements defer entry until ready')
  })

  for (const [name, options, reason] of [
    ['other author', { pr: { ...proposal, user: { login: 'someone', type: 'User' } } }, 'author'],
    [
      'spoofed app login',
      { pr: { ...proposal, user: { ...proposal.user, type: 'User' } } },
      'author',
    ],
    [
      'different head',
      { pr: { ...proposal, head: { ...proposal.head, sha: 'b'.repeat(40) } } },
      'head',
    ],
    ['invalid pushed SHA', { pushedSha: '' }, 'head'],
    ['draft', { pr: { ...proposal, draft: true } }, 'draft'],
    ['missing draft state', { pr: { ...proposal, draft: undefined } }, 'draft'],
    ['closed', { pr: { ...proposal, state: 'closed' } }, 'open same-repository'],
    ['different base', { pr: { ...proposal, base: { ...proposal.base, ref: 'other' } } }, 'main'],
    [
      'fork',
      { pr: { ...proposal, head: { ...proposal.head, repo: { full_name: 'fork/repo' } } } },
      'same-repository',
    ],
    ['empty diff', { pages: [] }, 'exactly one'],
    ['extra file on later page', { pages: [[manifest], [{ filename: 'other' }]] }, 'exactly one'],
    ['incomplete file list', { pr: { ...proposal, changed_files: 2 } }, 'exactly one'],
    ['other file', { pages: [[{ filename: 'other' }]] }, 'non-manifest'],
    [
      'renamed from other file',
      { pages: [[{ ...manifest, previous_filename: 'other' }]] },
      'non-manifest',
    ],
    ['unavailable API', { apiFailure: true }, 'unable to read'],
    ['invalid metadata', { pr: {} }, 'author'],
  ] as const) {
    it(`refuses ${name} without enqueueing`, () => {
      const result = run(options)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).not.toContain('MERGE_REQUESTED')
      expect(result.stderr).toContain(reason)
      expect(result.stderr).toContain('::error::')
    })
  }

  it('fails the job visibly when the queue request fails', () => {
    const result = run({ mergeFailure: true })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('queue request failed')
    expect(result.stderr).not.toContain('merge queue requested')
  })
})
