import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Effect, Option } from 'effect'
import * as Cli from 'effect/unstable/cli'

import { resolveConfig } from '../Config.ts'

type Trace = { kind: string; id: string; url: string }
type Job = {
  key: string
  status: string
  durationMs?: number
  traces: Trace[]
  topTasks: { name: string; durationMs: number }[]
}
type Run = { runId: string; attempt: number; status: string; trace?: { id: string; url: string }; jobs: Job[] }
type Comparison = {
  baselineCount: number
  tasks: {
    jobKey: string
    name: string
    sampleCount: number
    medianMs: number
    spreadMs: [number, number]
    prMs: number
    deltaMs: number
    classification: string
  }[]
}
type Document = {
  schema: string
  repository: string
  changeId: string
  status: string
  verdict?: { text: string; criticalChainKind: string; criticalChain: string[] }
  runs: Run[]
  comparison?: Comparison
}

const pr = Cli.Argument.integer('pr').pipe(Cli.Argument.withDescription('Pull request number'))
const repo = Cli.Flag.string('repo').pipe(Cli.Flag.optional)
const resolver = Cli.Flag.string('resolver').pipe(Cli.Flag.optional)
const freeze = Cli.Flag.boolean('freeze').pipe(Cli.Flag.withDefault(false))

const isDocument = (value: unknown): value is Document => {
  if (typeof value !== 'object' || value === null) return false
  const doc = value as Record<string, unknown>
  return doc.schema === 'buck2-trace-access/v1' && Array.isArray(doc.runs)
    && typeof doc.repository === 'string' && typeof doc.changeId === 'string'
}

const print = (doc: Document) => {
  console.log(`${doc.repository}#${doc.changeId}  ${doc.status}`)
  if (doc.verdict) {
    console.log(`Verdict: ${doc.verdict.text}`)
    console.log(`Slowest-job chain (${doc.verdict.criticalChainKind}): ${doc.verdict.criticalChain.join(' → ')}`)
  }
  for (const run of doc.runs) {
    console.log(`Run ${run.runId} (attempt ${run.attempt})  ${run.status}`)
    if (run.trace) console.log(`  Run trace: ${run.trace.id} ${run.trace.url}`)
    for (const job of run.jobs) {
      console.log(`  ${job.key}: ${job.status}${job.durationMs === undefined ? '' : ` (${job.durationMs} ms)`}`)
      for (const trace of job.traces) {
        console.log(`    ${trace.kind}: ${trace.id} ${trace.url}`)
        console.log(`      gcx traces get -d tempo ${trace.id} --llm -o json`)
        console.log(`      ${trace.url}/perfetto`)
      }
      for (const task of job.topTasks) console.log(`    ${task.name}: ${task.durationMs} ms`)
    }
  }
  for (const task of doc.comparison?.tasks ?? []) {
    console.log(`Δ ${task.jobKey}/${task.name}: ${task.deltaMs >= 0 ? '+' : ''}${task.deltaMs} ms vs ${task.medianMs} ms median (main ${task.spreadMs[0]}–${task.spreadMs[1]} ms, n=${task.sampleCount}; ${task.classification})`)
  }
}

const publishFreeze = async (doc: Document, prNumber: number) => {
  const slug = `buck2-pr-${doc.repository.replaceAll(/[^A-Za-z0-9-]/g, '-')}-${prNumber}-${Date.now()}`
  const dir = path.join('resources', 'vista', slug)
  await fs.mkdir(dir, { recursive: true })
  const facts = JSON.stringify(doc, null, 2)
  const source = `import { AppRoot, Evidence } from '@vista/blocks'\n\nconst facts = ${JSON.stringify(facts)}\n\nexport default function Snapshot() {\n  return <AppRoot title=${JSON.stringify(`${doc.repository}#${prNumber} build traces`)} template="architecture-review" scope="review"><Evidence id="resolver-snapshot"><pre>{facts}</pre></Evidence></AppRoot>\n}\n`
  await fs.writeFile(path.join(dir, 'app.tsx'), source, { flag: 'wx' })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('vista', ['publish', slug, '--message', `Freeze PR ${doc.repository}#${prNumber} trace evidence`], {
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Vista publish failed (${code}); source retained at ${dir}`)))
  })
}

export const tracesCommand = Cli.Command.make('traces', { pr, repo, resolver, freeze }).pipe(
  Cli.Command.withHandler(({ pr: number, repo: repoOpt, resolver: resolverOpt, freeze: shouldFreeze }) =>
    Effect.gen(function* () {
      if (!Number.isSafeInteger(number) || number <= 0) return yield* Effect.fail(new Error('PR number must be positive'))
      const config = yield* resolveConfig({})
      const selectedRepo = Option.isSome(repoOpt) ? repoOpt.value : config.repos[0]
      if (!selectedRepo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(selectedRepo)) {
        return yield* Effect.fail(new Error('Could not determine owner/repo; pass --repo owner/name'))
      }
      const base = Option.isSome(resolverOpt) ? resolverOpt.value : process.env.BUCK2_EVIDENCE_RESOLVER_URL ?? config.resolverUrl
      if (!base) return yield* Effect.fail(new Error('Set BUCK2_EVIDENCE_RESOLVER_URL or config.resolverUrl to a tailnet resolver URL'))
      const url = `${base.replace(/\/$/, '')}/pr/${selectedRepo}/${number}.json`
      const doc = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(url, { signal: AbortSignal.timeout(10000) })
          if (!response.ok) throw new Error(`Resolver returned HTTP ${response.status}`)
          const body: unknown = await response.json()
          if (!isDocument(body)) throw new Error('Unknown resolver JSON schema; expected buck2-trace-access/v1')
          return body
        },
        catch: (cause) => new Error(`Trace resolver unavailable (${url}); tailnet access is required: ${String(cause)}`),
      })
      print(doc)
      if (shouldFreeze) yield* Effect.tryPromise(() => publishFreeze(doc, number))
    }),
  ),
  Cli.Command.withDescription('Show PR run/job trace IDs from the tailnet resolver; --freeze publishes a Vista snapshot'),
)
