import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { parseJsonl } from './lib.mjs'

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

  it('does not measure a mutation when its baseline fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-baseline-test-'))
    try {
      const buck2 = join(directory, 'buck2')
      writeFileSync(
        buck2,
        `#!/bin/sh
case " $* " in
  *" --version "*) echo 'buck2 fake-baseline-test'; exit 0 ;;
  *"base-relevant-edit-"*) exit 23 ;;
  *) exit 0 ;;
esac
`,
      )
      chmodSync(buck2, 0o755)
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
          '//:check',
          '--work-contract',
          'workspace-typecheck/fake-baseline-test',
          '--runs',
          '1',
          '--warmups',
          '0',
          '--output',
          output,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 },
      )
      assert.equal(result.status, 0, result.stderr)
      const records = parseJsonl(readFileSync(output, 'utf8'))
      const relevantSamples = records.filter(
        (record) =>
          record.kind === 'sample' && record.engine === 'buck2' && record.phase === 'relevant-edit',
      )
      assert.equal(relevantSamples.length, 1)
      const [relevant] = relevantSamples
      assert.equal(relevant.status, 'skipped')
      assert.equal(relevant.verdict, 'no-verdict')
      assert.equal(relevant.reason, 'mutation-baseline-failed')
      assert.equal(relevant.control.exitCode, 23)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not measure a Buck warm no-op series when its warmup fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-warmup-test-'))
    try {
      const buck2 = join(directory, 'buck2')
      writeFileSync(
        buck2,
        `#!/bin/sh
case " $* " in
  *" --version "*) echo 'buck2 fake-warmup-test'; exit 0 ;;
  *"warmup.build-report.json"*) exit 31 ;;
  *) exit 0 ;;
esac
`,
      )
      chmodSync(buck2, 0o755)
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
          '//:check',
          '--work-contract',
          'workspace-typecheck/fake-warmup-test',
          '--runs',
          '1',
          '--warmups',
          '1',
          '--output',
          output,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 },
      )
      assert.equal(result.status, 0, result.stderr)
      const records = parseJsonl(readFileSync(output, 'utf8'))
      const warmNoop = records.filter(
        (record) =>
          record.kind === 'sample' && record.engine === 'buck2' && record.phase === 'warm-noop',
      )
      assert.equal(warmNoop.length, 2)
      assert.equal(warmNoop.find((record) => record.warmup === true)?.status, 'failed')
      const measured = warmNoop.filter((record) => record.warmup === false)
      assert.equal(measured.length, 1)
      assert.equal(measured[0]?.status, 'skipped')
      assert.equal(measured[0]?.verdict, 'no-verdict')
      assert.equal(measured[0]?.reason, 'warmup-failed')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('unwinds through cleanup when Buck incremental baseline preparation fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-preparation-test-'))
    try {
      const buck2 = join(directory, 'buck2')
      writeFileSync(
        buck2,
        `#!/bin/sh
case " $* " in
  *" --version "*) echo 'buck2 fake-preparation-test'; exit 0 ;;
  *"incremental-baseline.build-report.json"*) exit 29 ;;
  *) exit 0 ;;
esac
`,
      )
      chmodSync(buck2, 0o755)
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
          '//:check',
          '--work-contract',
          'workspace-typecheck/fake-preparation-test',
          '--runs',
          '1',
          '--warmups',
          '0',
          '--output',
          output,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 },
      )
      assert.notEqual(result.status, 0)
      const records = parseJsonl(readFileSync(output, 'utf8'))
      const cleanup = records.find((record) => record.kind === 'cleanup')
      assert.equal(cleanup?.status, 'ok')
      assert.equal(cleanup?.scratchWorktreeRemoved, true)
      parseJsonl(readFileSync(output.replace(/\.jsonl$/u, '.summary.jsonl'), 'utf8'))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restores an in-place mutation before terminating on SIGTERM', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'buck2-benchmark-signal-test-'))
    const repository = join(directory, 'repo')
    const relevant = 'src/relevant.ts'
    const original = 'export const value = 1\n'
    try {
      mkdirSync(join(repository, 'src'), { recursive: true })
      writeFileSync(join(repository, relevant), original)
      for (const args of [
        ['init', '--quiet'],
        // The disposable fixture must not inherit workstation commit-signing policy.
        ['config', '--local', 'commit.gpgsign', 'false'],
        ['config', 'user.email', 'test@example.invalid'],
        ['config', 'user.name', 'Buck benchmark test'],
        ['add', relevant],
        ['commit', '--quiet', '-m', 'fixture'],
      ]) {
        const hostileSigning = join(directory, 'hostile-gitconfig')
        writeFileSync(
          hostileSigning,
          '[commit]\n\tgpgsign = true\n[gpg]\n\tformat = ssh\n[user]\n\tsigningkey = /definitely/missing/signing-key.pub\n',
        )
        const result = spawnSync('git', args, {
          cwd: repository,
          encoding: 'utf8',
          env: { ...process.env, GIT_CONFIG_GLOBAL: hostileSigning },
        })
        assert.equal(result.status, 0, result.stderr)
      }
      const buck2 = join(directory, 'buck2')
      const mutationStarted = join(directory, 'mutation-started')
      writeFileSync(
        buck2,
        `#!/bin/sh
case " $* " in
  *" --version "*) echo 'buck2 fake-signal-test'; exit 0 ;;
  *"/relevant-edit-0.build-report.json"*) touch ${JSON.stringify(mutationStarted)}; sleep 5; exit 0 ;;
  *) exit 0 ;;
esac
`,
      )
      chmodSync(buck2, 0o755)
      const output = join(directory, 'raw.jsonl')
      const result = await new Promise((resolvePromise, reject) => {
        const child = spawn(
          process.execPath,
          [
            join(import.meta.dirname, 'benchmark.mjs'),
            '--execute',
            '--in-place',
            '--buck-incremental-only',
            '--buck-bin',
            buck2,
            '--buck-target',
            '//:check',
            '--work-contract',
            'workspace-typecheck/fake-signal-test',
            '--relevant-path',
            relevant,
            '--irrelevant-path',
            'missing.md',
            '--runs',
            '1',
            '--warmups',
            '0',
            '--output',
            output,
          ],
          { cwd: repository, stdio: 'pipe' },
        )
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          stderr += chunk
        })
        let signalSent = false
        const poll = setInterval(() => {
          if (signalSent === false && existsSync(mutationStarted) === true) {
            signalSent = true
            child.kill('SIGTERM')
          }
        }, 10)
        child.once('error', (error) => {
          clearInterval(poll)
          reject(error)
        })
        child.once('close', (code, signal) => {
          clearInterval(poll)
          resolvePromise({ code, signal, stderr })
        })
      })

      assert.equal(result.signal, null, result.stderr)
      assert.equal(result.code, 143, result.stderr)
      assert.equal(readFileSync(join(repository, relevant), 'utf8'), original)
      assert.equal(
        spawnSync('git', ['status', '--porcelain'], { cwd: repository, encoding: 'utf8' }).stdout,
        '',
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
