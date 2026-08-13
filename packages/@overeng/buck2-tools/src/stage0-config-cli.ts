#!/usr/bin/env bun
/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args -- CLI parsing follows the argv boundary. */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolveStage0Config,
  resolveStage0ConfigUnderLock,
  type Stage0ConfigRequest,
} from './stage0-config.ts'

interface ParsedCli {
  readonly internalWorker: boolean
  readonly request: Stage0ConfigRequest
  readonly output: 'path' | 'json'
  readonly expectedFingerprint?: string
}

const usage = `Usage: buck2-stage0-config [OPTIONS]

Resolve a validated Buck stage-0 config through a narrow, machine-local cache.

Options:
  --repo-root PATH           Repository root
  --cache-root PATH          Resolver cache root
  --nix-bin PATH             Exact Nix executable
  --flock-bin PATH           Exact util-linux flock executable
  --bun-bin PATH             Exact Bun executable used by the locked worker
  --semantic-input PATH      Semantic input below repo root; repeatable
  --format path|json         Output format (default: path)
  -h, --help                 Show help`

const valueAfter = (args: ReadonlyArray<string>, index: number): string => {
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${args[index]} requires a value`)
  return value
}

export const parseStage0ConfigCli = (args: ReadonlyArray<string>): ParsedCli => {
  let internalWorker = false
  let repoRoot: string | undefined
  let cacheRoot: string | undefined
  let nixBinary: string | undefined
  let flockBinary: string | undefined
  let bunBinary: string | undefined
  let resolverScript = fileURLToPath(import.meta.url)
  let platform: string | undefined
  let architecture: string | undefined
  let expectedFingerprint: string | undefined
  let output: 'path' | 'json' = 'path'
  const semanticInputs: Array<string> = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === '--internal-worker') internalWorker = true
    else if (arg === '--repo-root') repoRoot = valueAfter(args, index++)
    else if (arg === '--cache-root') cacheRoot = valueAfter(args, index++)
    else if (arg === '--nix-bin') nixBinary = valueAfter(args, index++)
    else if (arg === '--flock-bin') flockBinary = valueAfter(args, index++)
    else if (arg === '--bun-bin') bunBinary = valueAfter(args, index++)
    else if (arg === '--resolver-script') resolverScript = valueAfter(args, index++)
    else if (arg === '--semantic-input') semanticInputs.push(valueAfter(args, index++))
    else if (arg === '--platform') platform = valueAfter(args, index++)
    else if (arg === '--architecture') architecture = valueAfter(args, index++)
    else if (arg === '--expected-fingerprint') expectedFingerprint = valueAfter(args, index++)
    else if (arg === '--format') {
      const value = valueAfter(args, index++)
      if (value !== 'path' && value !== 'json') throw new Error('--format must be path or json')
      output = value
    } else if (arg === '-h' || arg === '--help') throw new Error('help')
    else throw new Error(`unknown option: ${arg}`)
  }
  const required = { repoRoot, cacheRoot, nixBinary, flockBinary, bunBinary }
  for (const [name, value] of Object.entries(required)) {
    if (value === undefined || value === '')
      throw new Error(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`)
  }
  return {
    internalWorker,
    output,
    ...(expectedFingerprint === undefined ? {} : { expectedFingerprint }),
    request: {
      repoRoot: resolve(repoRoot!),
      cacheRoot: resolve(cacheRoot!),
      nixBinary: resolve(nixBinary!),
      flockBinary: resolve(flockBinary!),
      bunBinary: resolve(bunBinary!),
      resolverScript: resolve(resolverScript),
      semanticInputs,
      ...(platform === undefined ? {} : { platform }),
      ...(architecture === undefined ? {} : { architecture }),
    },
  }
}

export const main = async (args = process.argv.slice(2)): Promise<number> => {
  let parsed: ParsedCli
  try {
    parsed = parseStage0ConfigCli(args)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== 'help') process.stderr.write(`buck2-stage0-config: ${message}\n\n`)
    process.stderr.write(`${usage}\n`)
    return message === 'help' ? 0 : 64
  }
  try {
    const result =
      parsed.internalWorker === true
        ? await resolveStage0ConfigUnderLock({
            request: parsed.request,
            ...(parsed.expectedFingerprint === undefined
              ? {}
              : { expectedFingerprint: parsed.expectedFingerprint }),
          })
        : await resolveStage0Config(parsed.request)
    if (parsed.internalWorker === true || parsed.output === 'json') {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    } else if ('configPath' in result) {
      process.stdout.write(`${result.configPath}\n`)
    } else {
      throw new Error('unexpected retry outside the locked worker')
    }
    return 0
  } catch (error) {
    process.stderr.write(
      `buck2-stage0-config: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 1
  }
}

if (import.meta.main) process.exitCode = await main()
