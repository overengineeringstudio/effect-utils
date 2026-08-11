import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseJsonl } from './lib.mjs'

const writeFakeBuck = ({ path, constantArtifactDigest = false, failRelevantBaseline = false }) => {
  const baselineFailure =
    failRelevantBaseline === true
      ? 'case "$report" in\n  *base-relevant-edit*) exit 23 ;;\nesac\n'
      : ''
  const artifactDigest =
    constantArtifactDigest === true
      ? "digest='constant-artifact:1'"
      : 'digest="$(cksum packages/@overeng/tui-core/src/mod.ts | awk \'{ print $1 ":" $2 }\')"'
  writeFileSync(
    path,
    `#!/bin/sh
case " $* " in
  *" --version "*) echo 'buck2 fake-artifact-test'; exit 0 ;;
  *" log "*) exit 0 ;;
esac
report=''
previous=''
for argument in "$@"; do
  if [ "$previous" = '--build-report' ]; then report="$argument"; fi
  previous="$argument"
done
[ -n "$report" ] || exit 0
${baselineFailure}${artifactDigest}
mkdir -p "$(dirname "$report")"
printf '{"success":true,"truncated":false,"results":{"root//packages/@overeng/tui-core:typescript_input_plan":{"success":"SUCCESS","configured":{"fake":{"artifact_info":{"DEFAULT":{"digest":"%s"}}}}}}}\\n' "$digest" > "$report"
exit 0
`,
  )
  chmodSync(path, 0o755)
}

const runFakeArtifactBenchmark = ({
  directory,
  constantArtifactDigest = false,
  failRelevantBaseline = false,
}) => {
  const buck2 = join(directory, 'buck2')
  writeFakeBuck({ path: buck2, constantArtifactDigest, failRelevantBaseline })
  const output = join(directory, 'raw.jsonl')
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, 'benchmark.mjs'),
      '--execute',
      '--buck-incremental-only',
      '--buck-bin',
      buck2,
      '--buck-target',
      '//packages/@overeng/tui-core:typescript_input_plan',
      '--buck-config',
      'buck2_nix.fake=/nix/store/fake-sensitive-value',
      '--work-contract',
      'package-artifact/fake-test',
      '--relevant-path',
      'packages/@overeng/tui-core/src/mod.ts',
      '--irrelevant-path',
      'context/dependency-materialization/intuition.md',
      '--runs',
      '1',
      '--warmups',
      '0',
      '--output',
      output,
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30_000,
    },
  )
  assert.equal(result.status, 0, result.stderr)
  return parseJsonl(readFileSync(output, 'utf8'))
}

describe('buck2 benchmark dry run', () => {
  it('emits a complete no-verdict plan without creating a worktree', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-dry-run-test-'))
    try {
      const output = join(directory, 'raw.jsonl')
      const result = spawnSync(
        process.execPath,
        [join(import.meta.dirname, 'benchmark.mjs'), '--output', output],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
        },
      )
      assert.equal(result.status, 0, result.stderr)
      const records = parseJsonl(readFileSync(output, 'utf8'))
      const samples = records.filter((record) => record.kind === 'sample')
      assert.equal(samples.length, 13)
      assert.ok(samples.every((record) => record.status === 'skipped'))
      assert.ok(samples.every((record) => record.verdict === 'no-verdict'))
      assert.ok(records.some((record) => record.kind === 'cleanup' && record.status === 'ok'))
      assert.ok(records.some((record) => record.kind === 'metadata' && record.mode === 'dry-run'))
      const summaries = parseJsonl(
        readFileSync(output.replace(/\.jsonl$/u, '.summary.jsonl'), 'utf8'),
      )
      assert.ok(
        summaries.every(
          (record) =>
            record.crossEngineComparison.generated === false &&
            record.crossEngineComparison.verdict === 'no-verdict',
        ),
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('requires an explicit Buck target and work contract before execution', () => {
    const missingContract = spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'benchmark.mjs'), '--execute', '--buck-target', '//:check'],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    assert.equal(missingContract.status, 2)
    assert.match(missingContract.stderr, /requires --work-contract/u)

    const missingTarget = spawnSync(
      process.execPath,
      [join(import.meta.dirname, 'benchmark.mjs'), '--execute', '--work-contract', 'test/v1'],
      { cwd: process.cwd(), encoding: 'utf8' },
    )
    assert.equal(missingTarget.status, 2)
    assert.match(missingTarget.stderr, /requires --buck-target/u)
  })

  it('records failed clean and kill controls as no-verdict samples', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-control-test-'))
    try {
      const bin = join(directory, 'bin')
      mkdirSync(bin)
      const devenv = join(bin, 'devenv')
      const buck2 = join(bin, 'buck2')
      writeFileSync(devenv, '#!/bin/sh\nexit 0\n')
      writeFileSync(
        buck2,
        `#!/bin/sh
case " $* " in
  *" --version "*) echo 'buck2 fake-control-test'; exit 0 ;;
  *" clean "*) exit 17 ;;
  *" kill "*) exit 19 ;;
  *) exit 0 ;;
esac
`,
      )
      chmodSync(devenv, 0o755)
      chmodSync(buck2, 0o755)
      const output = join(directory, 'raw.jsonl')
      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, 'benchmark.mjs'),
          '--execute',
          '--buck-bin',
          buck2,
          '--buck-target',
          '//:check',
          '--work-contract',
          'workspace-typecheck/fake-test',
          '--runs',
          '1',
          '--warmups',
          '0',
          '--output',
          output,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
          timeout: 30_000,
        },
      )
      assert.equal(result.status, 0, result.stderr)
      const records = parseJsonl(readFileSync(output, 'utf8'))
      const cleanSamples = records.filter(
        (record) => record.kind === 'sample' && record.phase === 'action-cold',
      )
      assert.equal(cleanSamples.length, 1)
      const [clean] = cleanSamples
      assert.equal(clean.status, 'skipped')
      assert.equal(clean.verdict, 'no-verdict')
      assert.equal(clean.reason, 'buck2-clean-control-failed')
      assert.equal(clean.control.exitCode, 17)
      const killSamples = records.filter(
        (record) => record.kind === 'sample' && record.phase === 'daemon-restart-cache-warm',
      )
      assert.equal(killSamples.length, 1)
      const [kill] = killSamples
      assert.equal(kill.status, 'skipped')
      assert.equal(kill.verdict, 'no-verdict')
      assert.equal(kill.reason, 'buck2-kill-control-failed')
      assert.equal(kill.control.exitCode, 19)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('verifies relevant artifact mutation and restoration without exposing Buck config values', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-artifact-test-'))
    try {
      const records = runFakeArtifactBenchmark({ directory })
      const relevant = records.find(
        (record) =>
          record.kind === 'sample' && record.engine === 'buck2' && record.phase === 'relevant-edit',
      )
      assert.equal(relevant.status, 'ok', JSON.stringify(relevant))
      assert.equal(relevant.verdict, 'measured')
      assert.equal(relevant.control.baseline.verdict, 'passed')
      assert.equal(relevant.artifactEvidence.verdict, 'verified')
      assert.equal(relevant.artifactEvidence.changed, true)
      assert.equal(relevant.artifactEvidence.restored, true)
      assert.notEqual(
        relevant.artifactEvidence.baselineDigest,
        relevant.artifactEvidence.mutatedDigest,
      )
      assert.equal(
        relevant.artifactEvidence.baselineDigest,
        relevant.artifactEvidence.restoredDigest,
      )
      assert.ok(relevant.command.includes('buck2_nix.fake=<redacted>'))
      assert.equal(JSON.stringify(relevant).includes('fake-sensitive-value'), false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('records a failed mutation baseline as no-verdict and does not measure the mutation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-baseline-test-'))
    try {
      const records = runFakeArtifactBenchmark({ directory, failRelevantBaseline: true })
      const relevant = records.find(
        (record) =>
          record.kind === 'sample' && record.engine === 'buck2' && record.phase === 'relevant-edit',
      )
      assert.equal(relevant.status, 'skipped')
      assert.equal(relevant.verdict, 'no-verdict')
      assert.equal(relevant.reason, 'mutation-baseline-failed')
      assert.equal(relevant.control.exitCode, 23)
      assert.equal(relevant.durationMs, null)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a relevant mutation whose artifact digest does not change', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-unchanged-test-'))
    try {
      const records = runFakeArtifactBenchmark({ directory, constantArtifactDigest: true })
      const relevant = records.find(
        (record) =>
          record.kind === 'sample' && record.engine === 'buck2' && record.phase === 'relevant-edit',
      )
      assert.equal(relevant.status, 'failed')
      assert.equal(relevant.verdict, 'no-verdict')
      assert.equal(relevant.reason, 'artifact-digest-unchanged')
      assert.equal(relevant.artifactEvidence.verdict, 'no-verdict')
      assert.equal(relevant.artifactEvidence.changed, false)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
