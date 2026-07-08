#!/usr/bin/env bun

import path from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Effect, Option, PubSub } from 'effect'

import { generateAll, mapResultToStatus, resolveOxfmtConfigPath } from '../src/core/core.ts'
import { GenieGenerationFailedError } from '../src/core/errors.ts'
import { type GenieEvent, GenieEventBus } from '../src/core/events.ts'
import type { GenieFile } from '../src/core/schema.ts'
import type { GenerateSuccess } from '../src/core/types.ts'

type RunnerOptions = {
  cwd: string
  output: 'json'
}

const usage = `Usage: genie-bootstrap-runner [--cwd <path>] [--phase bootstrap] [--output json]

Runs only the bootstrap-phase Genie generators. This binary is intentionally
narrow: it is the cold-proof runner, not the interactive Genie CLI.`

const readOptionValue = ({
  arg,
  index,
  argv,
  name,
}: {
  arg: string
  index: number
  argv: ReadonlyArray<string>
  name: string
}): { value: string; nextIndex: number } => {
  const prefix = `${name}=`
  if (arg.startsWith(prefix) === true) {
    return { value: arg.slice(prefix.length), nextIndex: index + 1 }
  }

  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--') === true) {
    throw new Error(`Missing value for ${name}`)
  }

  return { value, nextIndex: index + 2 }
}

const parseArgs = (argv: ReadonlyArray<string>): RunnerOptions | 'help' => {
  let cwd = '.'
  let output: RunnerOptions['output'] = 'json'
  let index = 0

  while (index < argv.length) {
    const arg = argv[index]
    if (arg === undefined) break

    if (arg === '--help' || arg === '-h') return 'help'

    if (arg === '--cwd' || arg.startsWith('--cwd=') === true) {
      const parsed = readOptionValue({ arg, index, argv, name: '--cwd' })
      cwd = parsed.value
      index = parsed.nextIndex
      continue
    }

    if (arg === '--phase' || arg.startsWith('--phase=') === true) {
      const parsed = readOptionValue({ arg, index, argv, name: '--phase' })
      if (parsed.value !== 'bootstrap') {
        throw new Error(
          `genie-bootstrap-runner only supports --phase bootstrap, got ${JSON.stringify(parsed.value)}`,
        )
      }
      index = parsed.nextIndex
      continue
    }

    if (arg === '--output' || arg.startsWith('--output=') === true) {
      const parsed = readOptionValue({ arg, index, argv, name: '--output' })
      if (parsed.value !== 'json') {
        throw new Error(
          `genie-bootstrap-runner only supports --output json, got ${JSON.stringify(parsed.value)}`,
        )
      }
      output = parsed.value
      index = parsed.nextIndex
      continue
    }

    throw new Error(`Unknown argument: ${arg}`)
  }

  return {
    cwd: path.isAbsolute(cwd) === true ? cwd : path.resolve(process.cwd(), cwd),
    output,
  }
}

const renderFile = ({ cwd, result }: { cwd: string; result: GenerateSuccess }): GenieFile => {
  const targetFilePath = result.targetFilePath
  return {
    path: targetFilePath,
    relativePath: path.relative(cwd, targetFilePath),
    status: mapResultToStatus(result),
    ...(result._tag === 'updated' && result.diffSummary !== undefined
      ? { message: result.diffSummary }
      : {}),
    ...(result._tag === 'skipped' ? { message: result.reason } : {}),
  }
}

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

const runBootstrap = ({ cwd }: RunnerOptions) =>
  Effect.gen(function* () {
    const bus = yield* PubSub.unbounded<GenieEvent>()
    const oxfmtConfigPath = yield* resolveOxfmtConfigPath({
      explicitPath: Option.none(),
      cwd,
    })

    const result = yield* generateAll({
      cwd,
      readOnly: true,
      dryRun: false,
      oxfmtConfigPath,
      phase: 'bootstrap',
    }).pipe(Effect.provideService(GenieEventBus, bus))

    printJson({
      phase: 'complete',
      mode: 'generate',
      cwd,
      files: result.files.map((file) => renderFile({ cwd, result: file })),
      summary: result.summary,
    })
  })

try {
  const options = parseArgs(process.argv.slice(2))
  if (options === 'help') {
    process.stdout.write(`${usage}\n`)
    process.exit(0)
  }

  await Effect.runPromise(runBootstrap(options).pipe(Effect.provide(NodeContext.layer)))
} catch (error) {
  if (error instanceof GenieGenerationFailedError) {
    printJson({
      phase: 'error',
      mode: 'generate',
      files: error.files,
      summary: {
        created: error.files.filter((file) => file.status === 'created').length,
        updated: error.files.filter((file) => file.status === 'updated').length,
        unchanged: error.files.filter((file) => file.status === 'unchanged').length,
        skipped: error.files.filter((file) => file.status === 'skipped').length,
        failed: error.failedCount,
      },
      error: error.message,
    })
    process.stderr.write(`${error.message}\n`)
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  }
  process.exit(1)
}
