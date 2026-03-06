/**
 * Alignment Commands
 *
 * Commands for the alignment coordinator workflow.
 * Used by the megarepo-all GitHub Actions workflow to render summaries
 * and poll PRs for merge status.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Duration } from 'effect'
import React from 'react'

import { outputOption, outputModeLayer } from '../../context.ts'
import {
  AlignmentApp,
  AlignmentView,
  renderMarkdownSummary,
  parseTasksFile,
  parseResultFile,
  type MemberState,
  type AlignmentState,
  type PollStatus,
} from '../../renderers/AlignmentOutput/mod.ts'

// =============================================================================
// Shared: read result files into member states
// =============================================================================

const readResultFiles = (resultsDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const entries = yield* fs.readDirectory(resultsDir).pipe(
      Effect.catchAll(() => Effect.succeed([] as readonly string[])),
    )

    /** Collect unique member names from file extensions */
    const memberNames = new Set<string>()
    for (const entry of entries) {
      for (const ext of ['.status', '.result', '.tasks']) {
        if (entry.endsWith(ext)) {
          memberNames.add(entry.slice(0, -ext.length))
        }
      }
    }

    const members: MemberState[] = []

    for (const name of [...memberNames].sort()) {
      let taskResults: MemberState['taskResults']
      let taskStatus: MemberState['taskStatus']
      let failedTaskDetails: MemberState['failedTaskDetails']
      let prResult: MemberState['prResult']
      let pollStatus: MemberState['pollStatus']

      // Read .tasks file
      const tasksPath = `${resultsDir}/${name}.tasks`
      const tasksExists = yield* fs.exists(tasksPath)
      if (tasksExists) {
        const tasksContent = yield* fs.readFileString(tasksPath)
        taskResults = [...parseTasksFile(tasksContent)]
        const hasWarning = taskResults.some((t) => t.status === 'warning')
        taskStatus = hasWarning ? 'warning' : 'ok'

        // Read failed task log snippets
        const failedTasks = taskResults.filter((t) => t.status !== 'ok')
        if (failedTasks.length > 0) {
          const details: { taskName: string; output: string }[] = []
          for (const task of failedTasks) {
            const logName = task.name.replace(/:/g, '-')
            const logPath = `${resultsDir}/${name}.task-${logName}.log`
            const logExists = yield* fs.exists(logPath)
            if (logExists) {
              const logContent = yield* fs.readFileString(logPath)
              const logLines = logContent.split('\n')
              const tail = logLines.slice(-20).join('\n')
              details.push({ taskName: task.name, output: tail })
            }
          }
          if (details.length > 0) {
            failedTaskDetails = details
          }
        }
      } else {
        // Check .status file for skipped members
        const statusPath = `${resultsDir}/${name}.status`
        const statusExists = yield* fs.exists(statusPath)
        if (statusExists) {
          const statusContent = yield* fs.readFileString(statusPath)
          const status = statusContent.trim()
          if (status === 'skipped') {
            taskStatus = 'skipped'
          } else if (status === 'warning') {
            taskStatus = 'warning'
          } else {
            taskStatus = 'ok'
          }
        }
      }

      // Read .result file
      const resultPath = `${resultsDir}/${name}.result`
      const resultExists = yield* fs.exists(resultPath)
      if (resultExists) {
        const resultContent = yield* fs.readFileString(resultPath)
        prResult = parseResultFile(resultContent)
      }

      // Read .pr_status file (from previous poll runs)
      const pollStatusPath = `${resultsDir}/${name}.pr_status`
      const pollStatusExists = yield* fs.exists(pollStatusPath)
      if (pollStatusExists) {
        const pollContent = yield* fs.readFileString(pollStatusPath)
        const rawStatus = pollContent.trim()
        const validStatuses: PollStatus[] = ['merged', 'checks_passed', 'checks_failed', 'closed', 'pending', 'timeout', 'no_pr']
        if (validStatuses.includes(rawStatus as PollStatus)) {
          pollStatus = rawStatus as PollStatus
        }
      }

      members.push({ name, taskResults, taskStatus, prResult, pollStatus, failedTaskDetails })
    }

    return members
  })

/** Write markdown summary to GITHUB_STEP_SUMMARY if available */
const writeGitHubSummary = (state: AlignmentState) =>
  Effect.gen(function* () {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY
    if (!summaryPath) return

    const fs = yield* FileSystem.FileSystem
    const markdown = renderMarkdownSummary(state)
    yield* fs.writeFileString(summaryPath, markdown)
  })

// =============================================================================
// Summary Command
// =============================================================================

const summaryCommand = Cli.Command.make(
  'summary',
  {
    output: outputOption,
    resultsDir: Cli.Options.text('results-dir').pipe(
      Cli.Options.withDescription('Path to alignment results directory'),
    ),
  },
  ({ output, resultsDir }) =>
    Effect.gen(function* () {
      const members = yield* readResultFiles(resultsDir)

      const state: typeof AlignmentState.Type = {
        phase: 'complete',
        members,
      }

      // Write GitHub summary
      yield* writeGitHubSummary(state)

      // Render TUI output
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* AlignmentApp.run(
            React.createElement(AlignmentView, { stateAtom: AlignmentApp.stateAtom }),
          )
          tui.dispatch({ _tag: 'SetState', state })
        }),
      ).pipe(Effect.provide(outputModeLayer(output)))
    }),
).pipe(Cli.Command.withDescription('Render alignment summary from result files'))

// =============================================================================
// Poll Command
// =============================================================================

const pollCommand = Cli.Command.make(
  'poll',
  {
    output: outputOption,
    resultsDir: Cli.Options.text('results-dir').pipe(
      Cli.Options.withDescription('Path to alignment results directory'),
    ),
    timeout: Cli.Options.integer('timeout').pipe(
      Cli.Options.withDescription('Max poll time in seconds'),
      Cli.Options.withDefault(1800),
    ),
    interval: Cli.Options.integer('interval').pipe(
      Cli.Options.withDescription('Poll interval in seconds'),
      Cli.Options.withDefault(30),
    ),
  },
  ({ output, resultsDir, timeout, interval }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const members = yield* readResultFiles(resultsDir)

      // Find members with PRs to poll
      const pollableMembers = members.filter(
        (m) =>
          m.prResult?.prNumber !== undefined &&
          (m.prResult.status === 'created' || m.prResult.status === 'updated'),
      )

      if (pollableMembers.length === 0) {
        // Nothing to poll — just render current state
        const state: typeof AlignmentState.Type = { phase: 'complete', members }
        yield* writeGitHubSummary(state)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const tui = yield* AlignmentApp.run(
              React.createElement(AlignmentView, { stateAtom: AlignmentApp.stateAtom }),
            )
            tui.dispatch({ _tag: 'SetState', state })
          }),
        ).pipe(Effect.provide(outputModeLayer(output)))
        return
      }

      // Resolve gh binary path
      const ghBin = yield* resolveGhBin()

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* AlignmentApp.run(
            React.createElement(AlignmentView, { stateAtom: AlignmentApp.stateAtom }),
          )

          // Initialize state
          tui.dispatch({
            _tag: 'SetState',
            state: { phase: 'polling', members },
          })

          const startTime = Date.now()
          const timeoutMs = timeout * 1000

          // Poll loop
          let done = false
          while (!done) {
            // Check each pollable member
            for (const member of pollableMembers) {
              if (!member.prResult?.repoSlug || !member.prResult?.prNumber) continue

              // Skip if already terminal
              const current = tui.getState().members.find((m) => m.name === member.name)
              if (current?.pollStatus && isTerminalStatus(current.pollStatus)) continue

              const status = yield* checkPRStatus({
                ghBin,
                repoSlug: member.prResult.repoSlug,
                prNumber: member.prResult.prNumber,
              })

              // Write .pr_status file
              yield* fs.writeFileString(`${resultsDir}/${member.name}.pr_status`, status)

              tui.dispatch({
                _tag: 'UpdateMember',
                name: member.name,
                update: { pollStatus: status },
              })
            }

            // Update GitHub summary after each cycle
            yield* writeGitHubSummary(tui.getState())

            // Check if all done
            const allTerminal = pollableMembers.every((m) => {
              const s = tui.getState().members.find((ms) => ms.name === m.name)
              return s?.pollStatus !== undefined && isTerminalStatus(s.pollStatus)
            })
            if (allTerminal) {
              done = true
              break
            }

            // Check timeout
            if (Date.now() - startTime >= timeoutMs) {
              for (const m of pollableMembers) {
                const s = tui.getState().members.find((ms) => ms.name === m.name)
                if (!s?.pollStatus || !isTerminalStatus(s.pollStatus)) {
                  yield* fs.writeFileString(`${resultsDir}/${m.name}.pr_status`, 'timeout')
                  tui.dispatch({
                    _tag: 'UpdateMember',
                    name: m.name,
                    update: { pollStatus: 'timeout' },
                  })
                }
              }
              yield* writeGitHubSummary(tui.getState())
              done = true
              break
            }

            yield* Effect.sleep(Duration.seconds(interval))
          }

          tui.dispatch({ _tag: 'SetPhase', phase: 'complete' })
          yield* writeGitHubSummary(tui.getState())
        }),
      ).pipe(Effect.provide(outputModeLayer(output)))
    }),
).pipe(Cli.Command.withDescription('Poll alignment PRs for merge status'))

// =============================================================================
// Helpers
// =============================================================================

const isTerminalStatus = (status: PollStatus): boolean =>
  status === 'merged' || status === 'checks_passed' || status === 'checks_failed' || status === 'closed' || status === 'timeout'

/** Resolve gh CLI binary — first try PATH, then fall back to nix */
const resolveGhBin = () =>
  Effect.gen(function* () {
    // Try gh from PATH first (already installed on runner)
    const fromPath = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(['which', 'gh'], { stdout: 'pipe', stderr: 'pipe' })
        const text = await new Response(proc.stdout).text()
        const code = await proc.exited
        if (code !== 0) throw new Error('gh not in PATH')
        return text.trim()
      },
      catch: () => new Error('gh not found in PATH'),
    }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    if (fromPath) return fromPath

    // Fall back to nix build
    const nixResult = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          ['nix', 'build', 'nixpkgs#gh', '--no-link', '--print-out-paths'],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const text = await new Response(proc.stdout).text()
        const code = await proc.exited
        if (code !== 0) throw new Error('nix build failed')
        return `${text.trim()}/bin/gh`
      },
      catch: () => new Error('Failed to resolve gh via nix'),
    })

    return nixResult
  })

/** Check PR merge/checks status via gh CLI */
const checkPRStatus = ({
  ghBin,
  repoSlug,
  prNumber,
}: {
  ghBin: string
  repoSlug: string
  prNumber: number
}): Effect.Effect<PollStatus> =>
  Effect.gen(function* () {
    // Check PR state and merge info
    const prInfo = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [ghBin, 'pr', 'view', String(prNumber), '--repo', repoSlug, '--json', 'state,mergedAt,mergeCommit'],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const text = await new Response(proc.stdout).text()
        const code = await proc.exited
        if (code !== 0) return undefined
        return JSON.parse(text) as { state: string; mergedAt: string | null; mergeCommit: { oid: string } | null }
      },
      catch: () => undefined,
    })

    if (!prInfo) return 'pending' as PollStatus

    // PR already merged
    if (prInfo.state === 'MERGED' || prInfo.mergedAt) return 'merged' as PollStatus

    // PR closed without merging
    if (prInfo.state === 'CLOSED') return 'closed' as PollStatus

    // Check CI status
    const checksResult = yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn(
          [ghBin, 'pr', 'checks', String(prNumber), '--repo', repoSlug, '--json', 'state'],
          { stdout: 'pipe', stderr: 'pipe' },
        )
        const text = await new Response(proc.stdout).text()
        const code = await proc.exited
        if (code !== 0) return undefined
        return JSON.parse(text) as Array<{ state: string }>
      },
      catch: () => undefined,
    })

    if (!checksResult || checksResult.length === 0) return 'pending' as PollStatus

    const allComplete = checksResult.every((c) => c.state !== 'PENDING' && c.state !== 'QUEUED' && c.state !== 'IN_PROGRESS')
    if (!allComplete) return 'pending' as PollStatus

    const allPassed = checksResult.every((c) => c.state === 'SUCCESS' || c.state === 'NEUTRAL' || c.state === 'SKIPPED')
    return allPassed ? ('checks_passed' as PollStatus) : ('checks_failed' as PollStatus)
  }).pipe(
    Effect.catchAll(() => Effect.succeed('pending' as PollStatus)),
  )

// =============================================================================
// Alignment command group
// =============================================================================

export const alignmentCommand = Cli.Command.make('alignment', {}).pipe(
  Cli.Command.withSubcommands([summaryCommand, pollCommand]),
  Cli.Command.withDescription('Alignment coordinator commands'),
)
