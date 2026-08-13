#!/usr/bin/env bun
/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args, overeng/explicit-boolean-compare -- CLI argv parsing intentionally mirrors positional process boundaries and boolean flags. */
import { resolve } from 'node:path'

import { launchBuck, quoteCommand, type ClosureManifestInput } from './launcher.ts'

interface ParsedCli {
  readonly buck: string
  readonly evidenceRoot?: string
  readonly closureManifests: ReadonlyArray<ClosureManifestInput>
  readonly compareReceipt?: string
  readonly buckVersion?: string
  readonly repositoryRevision?: string
  readonly executionPlatform?: string
  readonly launcherRunId?: string
  readonly printCommand: boolean
  readonly dryRun: boolean
  readonly buckArgs: ReadonlyArray<string>
}

const usage = `Usage: buck2-launcher [OPTIONS] -- <buck-command> [buck-args...]

Runs an already-realized Buck binary directly and writes buck-run-receipt/v1 evidence.

Options:
  --buck PATH                  Buck binary (or BUCK2_BIN)
  --buck-version VERSION       Pinned machine version for receipt correlation
  --repository-revision REV    Exact repository revision for receipt provenance
  --execution-platform SYSTEM  Exact Buck execution platform (for example x86_64-linux)
  --evidence-dir DIR           Receipt root (default: XDG state directory)
  --run-id ID                  Safe receipt directory name for machine-readable lookup
  --closure-manifest LABEL=PATH  Exact closure manifest; repeatable
  --compare-receipt PATH       Previous receipt for exact closure-digest explanation
  --print-command              Show the exact Buck command before execution
  --dry-run                    Show the command without executing it
  -h, --help                   Show help

Bypass: invoke the displayed Buck command directly. The launcher owns no build graph.`

const takeValue = (args: ReadonlyArray<string>, index: number, option: string): string => {
  const value = args[index + 1]
  if (value === undefined || value === '--') throw new Error(`${option} requires a value`)
  return value
}

export const parseCli = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv): ParsedCli => {
  const separator = args.indexOf('--')
  if (separator < 0) throw new Error('missing -- before the Buck command')
  const own = args.slice(0, separator)
  const buckArgs = args.slice(separator + 1)
  if (buckArgs.length === 0) throw new Error('missing Buck command after --')
  let buck = env.BUCK2_BIN
  let evidenceRoot: string | undefined
  let compareReceipt: string | undefined
  let buckVersion = env.BUCK2_MACHINE_VERSION
  let repositoryRevision = env.BUCK2_REPOSITORY_REVISION
  let executionPlatform = env.BUCK2_EXECUTION_PLATFORM
  let launcherRunId: string | undefined
  let printCommand = false
  let dryRun = false
  const closureManifests: Array<ClosureManifestInput> = []
  for (let index = 0; index < own.length; index += 1) {
    const arg = own[index]!
    if (arg === '--buck') buck = takeValue(own, index++, arg)
    else if (arg === '--buck-version') buckVersion = takeValue(own, index++, arg)
    else if (arg === '--repository-revision') repositoryRevision = takeValue(own, index++, arg)
    else if (arg === '--execution-platform') executionPlatform = takeValue(own, index++, arg)
    else if (arg === '--evidence-dir') evidenceRoot = takeValue(own, index++, arg)
    else if (arg === '--run-id') launcherRunId = takeValue(own, index++, arg)
    else if (arg === '--compare-receipt') compareReceipt = takeValue(own, index++, arg)
    else if (arg === '--closure-manifest') {
      const value = takeValue(own, index++, arg)
      const equals = value.indexOf('=')
      if (equals <= 0 || equals === value.length - 1) throw new Error(`${arg} expects LABEL=PATH`)
      closureManifests.push({
        label: value.slice(0, equals),
        path: resolve(value.slice(equals + 1)),
      })
    } else if (arg === '--print-command') printCommand = true
    else if (arg === '--dry-run') {
      dryRun = true
      printCommand = true
    } else if (arg === '-h' || arg === '--help') throw new Error('help')
    else throw new Error(`unknown launcher option: ${arg}`)
  }
  if (buck === undefined || buck.trim() === '') throw new Error('--buck or BUCK2_BIN is required')
  if (dryRun === false && (repositoryRevision === undefined || repositoryRevision.trim() === '')) {
    throw new Error('--repository-revision or BUCK2_REPOSITORY_REVISION is required')
  }
  if (dryRun === false && (executionPlatform === undefined || executionPlatform.trim() === '')) {
    throw new Error('--execution-platform or BUCK2_EXECUTION_PLATFORM is required')
  }
  return {
    buck,
    ...(repositoryRevision === undefined ? {} : { repositoryRevision }),
    ...(executionPlatform === undefined ? {} : { executionPlatform }),
    ...(evidenceRoot === undefined ? {} : { evidenceRoot: resolve(evidenceRoot) }),
    closureManifests,
    ...(compareReceipt === undefined ? {} : { compareReceipt: resolve(compareReceipt) }),
    ...(buckVersion === undefined ? {} : { buckVersion }),
    ...(launcherRunId === undefined ? {} : { launcherRunId }),
    printCommand,
    dryRun,
    buckArgs,
  }
}

export const main = async (args = process.argv.slice(2)): Promise<number> => {
  let parsed: ParsedCli
  try {
    parsed = parseCli(args, process.env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== 'help') process.stderr.write(`buck2-launcher: CRITICAL ${message}\n\n`)
    process.stderr.write(`${usage}\n`)
    return message === 'help' ? 0 : 64
  }
  if (parsed.printCommand)
    process.stderr.write(`buck2-launcher: ${quoteCommand(parsed.buck, parsed.buckArgs)}\n`)
  if (parsed.dryRun) return 0
  if (parsed.repositoryRevision === undefined || parsed.executionPlatform === undefined) {
    throw new Error('launcher identity invariant violated')
  }
  try {
    const result = await launchBuck({
      buckBinary: parsed.buck,
      buckArgs: parsed.buckArgs,
      cwd: process.cwd(),
      repositoryRevision: parsed.repositoryRevision,
      executionPlatform: parsed.executionPlatform,
      ...(parsed.evidenceRoot === undefined ? {} : { evidenceRoot: parsed.evidenceRoot }),
      closureManifests: parsed.closureManifests,
      ...(parsed.compareReceipt === undefined ? {} : { compareReceipt: parsed.compareReceipt }),
      ...(parsed.buckVersion === undefined ? {} : { buckMachineVersion: parsed.buckVersion }),
      ...(parsed.launcherRunId === undefined ? {} : { launcherRunId: parsed.launcherRunId }),
      stderr: process.stderr,
    })
    if (result.receiptPath !== undefined)
      process.stderr.write(`buck2-launcher: receipt ${result.receiptPath}\n`)
    // Preserve Buck failures. A successful build without its required receipt is an infrastructure failure.
    return result.exitCode !== 0 ? result.exitCode : result.receiptError === undefined ? 0 : 74
  } catch (error) {
    process.stderr.write(
      `buck2-launcher: CRITICAL ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return 70
  }
}

if (import.meta.main) process.exitCode = await main()
