import { describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { standaloneCachePostureConfig } from '../../scripts/buck2-cache-posture.ts'

type GeneratedWorkflow = {
  env?: Record<string, string>
  jobs: Record<
    string,
    {
      if?: string
      needs?: string[]
      env?: Record<string, string>
      steps: Array<{
        name?: string
        uses?: string
        if?: string
        env?: Record<string, string>
        run?: string
        with?: Record<string, string | number>
      }>
    }
  >
}

const readWorkflow = async (filename = 'ci.yml'): Promise<GeneratedWorkflow> =>
  Bun.YAML.parse(
    await Bun.file(new URL(`../../.github/workflows/${filename}`, import.meta.url)).text(),
  ) as GeneratedWorkflow

const evaluate = (
  value: string,
  event: string,
  ref: string,
  baseRef = 'refs/heads/main',
  tested = false,
): unknown => {
  if (value.startsWith('${{') === false) return value
  const expression = value
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .replaceAll('needs.tested-tree', "needs['tested-tree']")
  return new Function(
    'github',
    'inputs',
    'secrets',
    'startsWith',
    'cancelled',
    'needs',
    `return (${expression})`,
  )(
    { event_name: event, ref, event: { merge_group: { base_ref: baseRef } } },
    { measurement_baseline_ref: '' },
    { BUCK2_PUBLIC_CACHE_WRITE_AUTH: 'fixture-credential' },
    (text: string, prefix: string) => text.startsWith(prefix),
    () => false,
    { 'tested-tree': { outputs: { tested: tested === true ? 'true' : 'false' } } },
  )
}

const writers: Record<string, true> = {
  quality: true,
  test: true,
  'test-macos': true,
  'test-playwright-utils': true,
  'test-playwright-tui-react': true,
  cargo: true,
  weaver: true,
  'test-integration-restate': true,
  'test-storybook-plays': true,
}
const strictWriter = 'trusted-buck2-remote-cache-proof'

const scenarios = [
  { event: 'push', ref: 'refs/heads/main', base: 'refs/heads/main', trusted: true },
  {
    event: 'merge_group',
    ref: 'refs/heads/gh-readonly-queue/main/pr-123',
    base: 'refs/heads/main',
    trusted: true,
  },
  {
    event: 'merge_group',
    ref: 'refs/heads/gh-readonly-queue/main/pr-123',
    base: 'refs/heads/other',
    trusted: false,
  },
  {
    event: 'merge_group',
    ref: 'refs/heads/gh-readonly-queue/other/pr-123',
    base: 'refs/heads/main',
    trusted: false,
  },
  { event: 'merge_group', ref: 'refs/heads/main', base: 'refs/heads/main', trusted: false },
  ...['pull_request', 'pull_request_target', 'schedule', 'workflow_dispatch', 'push'].flatMap(
    (event) =>
      ['refs/pull/123/merge', 'refs/heads/feature', 'refs/heads/gh-readonly-queue/main/pr-123'].map(
        (ref) => ({ event, ref, base: 'refs/heads/main', trusted: false }),
      ),
  ),
  { event: 'pull_request', ref: 'refs/heads/main', base: 'refs/heads/main', trusted: false },
  { event: 'workflow_dispatch', ref: 'refs/heads/main', base: 'refs/heads/main', trusted: false },
]

describe('generated CI cache trust behavior', () => {
  it('enables opportunistic uploads only with a protected main or queue event and step-local credential', async () => {
    for (const filename of ['ci.yml', 'storybook-plays.yml']) {
      const workflow = await readWorkflow(filename)
      expect(JSON.stringify(workflow.env ?? {})).not.toContain(
        'secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH',
      )
      for (const [id, job] of Object.entries(workflow.jobs)) {
        expect(JSON.stringify(job.env ?? {})).not.toContain('secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH')
        if (id === strictWriter) continue
        for (const scenario of scenarios) {
          const env = Object.fromEntries(
            Object.entries(job.env ?? {})
              .filter(([key]) => key.startsWith('BUCK2_'))
              .map(([key, value]) => [
                key,
                String(evaluate(value, scenario.event, scenario.ref, scenario.base)),
              ]),
          )
          const writerSteps = job.steps.filter(
            (step) => step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH !== undefined,
          )
          if (writers[id] === true) expect(writerSteps.length).toBeGreaterThan(0)
          else expect(writerSteps).toHaveLength(0)
          for (const step of job.steps) {
            const credential = step.env?.BUCK2_PUBLIC_CACHE_WRITE_AUTH
            const supplied =
              credential === undefined
                ? ''
                : String(evaluate(credential, scenario.event, scenario.ref, scenario.base))
            expect(supplied).toBe(
              writers[id] === true && credential !== undefined && scenario.trusted === true
                ? 'fixture-credential'
                : '',
            )
          }
          // Reader policy wins even if an accidental credential reaches the resolver.
          const config = standaloneCachePostureConfig({
            current: '',
            trustedOrigin: { tier: 'private', urlPrefix: 'https://cache.example/cas/' },
            env: { ...env, BUCK2_CACHE_WRITE_BASIC_AUTH: 'fixture-credential' },
          })
          expect(config).toContain(
            `allow_cache_uploads = ${writers[id] === true && scenario.trusted === true ? 'true' : 'false'}`,
          )
          expect(env.BUCK2_CACHE_WRITE_OPTIONAL).toBe(writers[id] === true ? '1' : undefined)
        }
      }
    }
  })

  it('keeps the strict remote cache proof on main and never admits it on PR or queue events', async () => {
    const job = (await readWorkflow()).jobs[strictWriter]!
    for (const scenario of scenarios.filter(
      ({ event }) => event === 'pull_request' || event === 'merge_group',
    ))
      expect(Boolean(evaluate(job.if!, scenario.event, scenario.ref, scenario.base))).toBe(false)
    expect(job.env?.BUCK2_CACHE_WRITE_OPTIONAL).toBeUndefined()
  })

  it('skips main heavy lanes only for tested trees and still runs queues, publishers and the proof', async () => {
    const workflow = await readWorkflow()
    for (const id of [
      ...Object.keys(writers).filter((id) => id !== 'test-storybook-plays'),
      'build-products',
    ]) {
      const job = workflow.jobs[id]!
      expect(Boolean(evaluate(job.if!, 'push', 'refs/heads/main', undefined, true))).toBe(false)
      expect(Boolean(evaluate(job.if!, 'push', 'refs/heads/main', undefined, false))).toBe(true)
      expect(
        Boolean(
          evaluate(
            job.if!,
            'merge_group',
            'refs/heads/gh-readonly-queue/main/pr-123',
            undefined,
            true,
          ),
        ),
      ).toBe(true)
    }
    for (const id of ['publish-products', 'deploy-storybooks', strictWriter])
      expect(
        Boolean(evaluate(workflow.jobs[id]!.if!, 'push', 'refs/heads/main', undefined, true)),
      ).toBe(true)
  })

  it('dispatches alignment after reused queue evidence without ignoring failed publication', async () => {
    const job = (await readWorkflow()).jobs['notify-alignment']!
    expect(job.needs).toContain('tested-tree')
    expect(job.needs).toContain('quality')
    const expression = job
      .if!.slice(3, -2)
      .replaceAll('needs.*.result', 'results')
      .replaceAll('needs.tested-tree', "needs['tested-tree']")
    const check = new Function(
      'github',
      'needs',
      'results',
      'contains',
      'cancelled',
      `return (${expression})`,
    )
    const run = (
      tested: string | undefined,
      quality: string,
      publication: string,
      lookup = 'success',
    ) =>
      check(
        { event_name: 'push', ref: 'refs/heads/main' },
        {
          quality: { result: quality },
          'tested-tree': { result: lookup, outputs: { tested } },
          ...Object.fromEntries(
            job
              .needs!.filter((id) => id !== 'quality' && id !== 'tested-tree')
              .map((id) => [id, { result: publication }]),
          ),
        },
        [lookup, quality, publication],
        (values: string[], value: string) => values.includes(value),
        () => false,
      )
    expect(run('true', 'skipped', 'success')).toBe(true)
    expect(run('false', 'success', 'success')).toBe(true)
    expect(run('false', 'skipped', 'success')).toBe(false)
    expect(run('true', 'skipped', 'failure')).toBe(false)
    expect(run('true', 'skipped', 'cancelled')).toBe(false)
    expect(run(undefined, 'success', 'success', 'failure')).toBe(true)
    expect(run(undefined, 'success', 'failure', 'failure')).toBe(false)
    expect(run(undefined, 'success', 'cancelled', 'failure')).toBe(false)
  })

  it('runs policy tests by explicit source paths instead of searching Buck outputs', async () => {
    const workflow = await readWorkflow()
    const audit = workflow.jobs.quality!.steps.find(
      (step) => step.name === 'Audit native dependency policy',
    )
    const tests = [
      './genie/ci-scripts/tested-tree.unit.test.ts',
      './genie/ci-workflow/buck2-cache-posture.unit.test.ts',
      './genie/ci-workflow/buck2-cache-posture.integration.test.ts',
    ].join(' ')
    expect(audit?.run).toContain(`bun test ${tests}`)
    expect(audit?.run).toContain(`nix run nixpkgs#bun -- test ${tests}`)
  })

  it('keeps credential-free build and preview workflows read-only', async () => {
    for (const filename of ['compiled-products.yml', 'storybook-preview-build.yml'])
      for (const job of Object.values((await readWorkflow(filename)).jobs)) {
        expect(job.env?.BUCK2_PUBLIC_CACHE_READ_ONLY).toBe('1')
        expect(JSON.stringify(job)).not.toContain('secrets.BUCK2_PUBLIC_CACHE_WRITE_AUTH')
      }
  })

  it('publishes the exact retained shell closure only from protected main', async () => {
    const publisher = (await readWorkflow('compiled-products.yml')).jobs[
      'publish-compiled-products'
    ]!
    const publication = publisher.steps.find(
      (step) => step.name === 'Publish retained shell, native and compiled products',
    )!
    expect(evaluate(publisher.if!, 'push', 'refs/heads/main')).toBe(true)
    expect(evaluate(publisher.if!, 'workflow_dispatch', 'refs/heads/main')).toBe(true)
    for (const event of ['pull_request', 'merge_group']) {
      expect(evaluate(publisher.if!, event, 'refs/heads/main')).toBe(false)
    }
    expect(evaluate(publisher.if!, 'workflow_dispatch', 'refs/heads/topic')).toBe(false)
    expect(publication.run).toContain('compiled-products.sh --push')
    expect(publication.env?.CACHIX_AUTH_TOKEN).toBe('${{ secrets.CACHIX_AUTH_TOKEN }}')
    const script = await Bun.file(
      new URL('../ci-scripts/compiled-products.sh', import.meta.url),
    ).text()
    expect(script).toContain('refs=(.#ci-test-shell-products)')
    expect(script.match(/\bnix build\b/g)).toHaveLength(1)
    expect(script).toContain('--json "${refs[@]}"')
    expect(script).toContain('cachix push overeng-effect-utils $outputs')
    expect(script).toContain('if [ "$matches" -ne 1 ]; then')
    expect(script).toContain('"$out/bin/$name" --help')
    expect(script).toContain('if [ "$push" = true ]; then')
    const flake = await Bun.file(new URL('../../flake.nix', import.meta.url)).text()
    expect(flake).toContain('ci-test-shell-products = pkgs.linkFarm')
    expect(flake).toContain(
      'inherit (nativeProductPackages) otelite otel-scrape typescript-api-server;',
    )
  })

  it('realizes every inventoried product once, smokes unordered outputs and publishes only on request', () => {
    const work = mkdtempSync(join(tmpdir(), 'compiled-products-contract-'))
    const script = fileURLToPath(new URL('../ci-scripts/compiled-products.sh', import.meta.url))
    const names = ['compiled-one', 'compiled-two', 'native-one']
    const outputPaths = names.map((name) => join(work, `output-${name}`))
    const shellOutput = join(work, 'output-shell')
    const logs = {
      NIX_LOG: join(work, 'nix.log'),
      SMOKE_LOG: join(work, 'smoke.log'),
      CACHE_LOG: join(work, 'cache.log'),
    }
    const executable = ({ path, content }: { path: string; content: string }) => {
      writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${content}\n`)
      chmodSync(path, 0o755)
    }
    try {
      mkdirSync(join(work, 'nix/buck2-products'), { recursive: true })
      mkdirSync(join(work, 'tools'))
      mkdirSync(shellOutput)
      writeFileSync(
        join(work, 'nix/buck2-products/compiled-targets.json'),
        JSON.stringify({ products: names.slice(0, 2).map((name) => ({ name })) }),
      )
      writeFileSync(
        join(work, 'nix/buck2-products/native-targets.json'),
        JSON.stringify({ products: [{ name: names[2] }] }),
      )
      names.forEach((name, index) => {
        const bin = join(outputPaths[index]!, 'bin')
        mkdirSync(bin, { recursive: true })
        executable({
          path: join(bin, name),
          content: `printf '%s %s\\n' '${name}' "$*" >> "$SMOKE_LOG"\n[ "$*" = --help ]\n[ "\${FAIL_PRODUCT:-}" != '${name}' ]`,
        })
      })
      executable({
        path: join(work, 'tools/nix'),
        content: 'printf \'%s\\n\' "$*" >> "$NIX_LOG"\nprintf \'%s\\n\' "$BUILD_JSON"',
      })
      executable({
        path: join(work, 'tools/cachix'),
        content: 'printf \'%s\\n\' "$*" >> "$CACHE_LOG"',
      })
      const outputs = [outputPaths[2]!, shellOutput, outputPaths[1]!, outputPaths[0]!]
      const run = ({
        args,
        selectedOutputs = outputs,
        failProduct = '',
      }: {
        args: string[]
        selectedOutputs?: string[]
        failProduct?: string
      }) => {
        for (const path of Object.values(logs)) writeFileSync(path, '')
        return Bun.spawnSync({
          cmd: ['bash', script, ...args],
          cwd: work,
          env: {
            ...process.env,
            ...logs,
            PATH: `${join(work, 'tools')}:${process.env.PATH ?? ''}`,
            BUILD_JSON: JSON.stringify(
              selectedOutputs.map((out) => ({ drvPath: `${out}.drv`, outputs: { out } })),
            ),
            FAIL_PRODUCT: failProduct,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
      }
      for (const args of [[], ['--push']]) {
        expect(run({ args }).exitCode).toBe(0)
        expect(readFileSync(logs.NIX_LOG, 'utf8').trim().split('\n')).toEqual([
          'build --no-link --print-build-logs --json .#ci-test-shell-products .#compiled-one-compiled .#compiled-two-compiled .#native-one',
        ])
        expect(readFileSync(logs.SMOKE_LOG, 'utf8').trim().split('\n')).toEqual(
          names.map((name) => `${name} --help`),
        )
        expect(readFileSync(logs.CACHE_LOG, 'utf8')).toBe(
          args.length === 0 ? '' : `push overeng-effect-utils ${outputs.join(' ')}\n`,
        )
      }
      expect(
        run({
          args: ['--push'],
          selectedOutputs: outputs.filter((out) => out !== outputPaths[2]),
        }).exitCode,
      ).not.toBe(0)
      expect(readFileSync(logs.CACHE_LOG, 'utf8')).toBe('')
      const duplicate = join(work, 'output-duplicate')
      mkdirSync(join(duplicate, 'bin'), { recursive: true })
      executable({ path: join(duplicate, 'bin/native-one'), content: 'exit 0' })
      expect(run({ args: ['--push'], selectedOutputs: [...outputs, duplicate] }).exitCode).not.toBe(
        0,
      )
      expect(readFileSync(logs.CACHE_LOG, 'utf8')).toBe('')
      expect(run({ args: ['--push'], failProduct: 'compiled-two' }).exitCode).not.toBe(0)
      expect(readFileSync(logs.CACHE_LOG, 'utf8')).toBe('')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('uploads both native evidence artifacts for every decorated workflow job', async () => {
    for (const filename of [
      'ci.yml',
      'compiled-products.yml',
      'storybook-plays.yml',
      'storybook-preview-build.yml',
    ]) {
      const workflow = await readWorkflow(filename)
      for (const job of Object.values(workflow.jobs)) {
        const start = job.steps.find((step) => step.name === 'Start Buck2 cache evidence window')
        if (start === undefined) continue
        expect(job.env?.CI_BUCK2_CACHE_ACTIONS_PATH).toBe(
          '${{ github.workspace }}/tmp/buck2-cache-actions.jsonl.gz',
        )
        expect(start.run).toContain('CI_BUCK2_CACHE_EVIDENCE_STARTED_AT')
        expect(start.run).toContain('[ ! -e "$source_root/buck-out" ]')
        expect(start.run).toContain('[ ! -L "$source_root/buck-out" ]')
        const uploads = job.steps.filter((step) => step.name === 'Upload Buck2 cache evidence')
        expect(uploads).toHaveLength(1)
        expect(uploads[0]?.if).toBe('${{ always() }}')
        expect(String(uploads[0]?.with?.path).trimEnd()).toBe(
          '${{ env.CI_BUCK2_CACHE_EVIDENCE_PATH }}\n${{ env.CI_BUCK2_CACHE_ACTIONS_PATH }}',
        )
        expect(uploads[0]?.with?.['retention-days']).toBe(14)
      }
    }
  })
})
