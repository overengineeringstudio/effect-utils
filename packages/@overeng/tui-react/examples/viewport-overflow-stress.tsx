#!/usr/bin/env bun
/**
 * Viewport overflow stress test.
 *
 * Simulates a long-running process (like genie) that progressively updates
 * file statuses, then shows a final summary. Tests that tui-react's safety
 * net prevents terminal scrolling throughout the process.
 *
 * Uses createTuiApp with Effect orchestration (same pattern as genie).
 *
 * Usage:
 *   bun examples/viewport-overflow-stress.tsx footer          # Genie-like progressive updates (default)
 *   bun examples/viewport-overflow-stress.tsx vertical         # Simple vertical overflow
 *   bun examples/viewport-overflow-stress.tsx combined         # Vertical + horizontal overflow
 *   bun examples/viewport-overflow-stress.tsx footer 200 10    # 200 files, 10ms delay
 */

import type { Atom } from '@effect-atom/atom'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import React, { useMemo } from 'react'

import {
  createTuiApp,
  outputModeLayer,
  Box,
  Text,
  Spinner,
  useViewport,
  useTuiAtomValue,
} from '../src/mod.tsx'

// =============================================================================
// State & Actions
// =============================================================================

type FileStatus = 'pending' | 'processing' | 'ok' | 'error' | 'unchanged'

const FileEntry = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
})

const AppState = Schema.Union(
  Schema.TaggedStruct('Discovering', {
    files: Schema.Array(FileEntry),
  }),
  Schema.TaggedStruct('Generating', {
    files: Schema.Array(FileEntry),
    processed: Schema.Number,
    total: Schema.Number,
  }),
  Schema.TaggedStruct('Complete', {
    files: Schema.Array(FileEntry),
    total: Schema.Number,
  }),
  Schema.TaggedStruct('Interrupted', {}),
)

type AppState = typeof AppState.Type

const AppAction = Schema.Union(
  Schema.TaggedStruct('StartGenerating', {}),
  Schema.TaggedStruct('ProcessFile', {
    index: Schema.Number,
    status: Schema.String,
  }),
  Schema.TaggedStruct('MarkActive', {
    index: Schema.Number,
  }),
  Schema.TaggedStruct('Finish', {}),
  Schema.TaggedStruct('Interrupted', {}),
)

type AppAction = typeof AppAction.Type

const appReducer = ({ state, action }: { state: AppState; action: AppAction }): AppState => {
  switch (action._tag) {
    case 'StartGenerating':
      if (state._tag !== 'Discovering') return state
      return {
        _tag: 'Generating',
        files: state.files,
        processed: 0,
        total: state.files.length,
      }
    case 'MarkActive':
      if (state._tag !== 'Generating') return state
      return {
        ...state,
        files: state.files.map((f, i) => (i === action.index ? { ...f, status: 'processing' } : f)),
      }
    case 'ProcessFile':
      if (state._tag !== 'Generating') return state
      return {
        ...state,
        files: state.files.map((f, i) =>
          i === action.index ? { ...f, status: action.status } : f,
        ),
        processed: state.processed + 1,
      }
    case 'Finish':
      if (state._tag !== 'Generating') return state
      return { _tag: 'Complete', files: state.files, total: state.total }
    case 'Interrupted':
      // Don't overwrite Complete state
      if (state._tag === 'Complete') return state
      return { _tag: 'Interrupted' }
  }
}

// =============================================================================
// View
// =============================================================================

const FileList = ({ files }: { files: readonly { name: string; status: string }[] }) => {
  const viewport = useViewport()

  const reservedLines = 1 + 1 + 1 + 1 + 1 // header + blank + overflow + separator + footer
  const availableLines = Math.max(1, viewport.rows - reservedLines)

  const { visibleFiles, hiddenCount } = useMemo(() => {
    if (files.length <= availableLines) {
      return { visibleFiles: files, hiddenCount: 0 }
    }
    return {
      visibleFiles: files.slice(0, availableLines - 1),
      hiddenCount: files.length - (availableLines - 1),
    }
  }, [files, availableLines])

  return (
    <>
      {visibleFiles.map((file) => (
        <Text key={file.name}>
          {file.status === 'error'
            ? '✗'
            : file.status === 'processing'
              ? '◌'
              : file.status === 'pending'
                ? '○'
                : '✓'}{' '}
          {file.name}
          {file.status === 'error' ? ' error: Failed to generate ...' : ''}
          {file.status === 'processing' ? ' generating...' : ''}
        </Text>
      ))}
      {hiddenCount > 0 && <Text dim>... {hiddenCount} more files</Text>}
    </>
  )
}

const StressView = ({ stateAtom }: { stateAtom: Atom.Atom<AppState> }) => {
  const state = useTuiAtomValue(stateAtom)
  const viewport = useViewport()

  if (state._tag === 'Interrupted') {
    return <Text color="yellow">⚠ Operation cancelled</Text>
  }

  if (state._tag === 'Complete') {
    const errorCount = state.files.filter((f) => f.status === 'error').length
    const okCount = state.files.filter((f) => f.status === 'ok').length
    const unchangedCount = state.files.filter((f) => f.status === 'unchanged').length
    return (
      <Box>
        <Box flexDirection="row">
          <Text color="green">✓</Text>
          <Text> Complete</Text>
          <Text dim>
            {' '}
            (viewport: {viewport.columns}x{viewport.rows})
          </Text>
        </Box>
        <Text> </Text>
        <Text dim>{'─'.repeat(40)}</Text>
        <Text>
          Processed {state.total} files: {okCount} ok, {unchangedCount} unchanged, {errorCount}{' '}
          failed
        </Text>
      </Box>
    )
  }

  const processed = state._tag === 'Generating' ? state.processed : 0
  const total = state._tag === 'Generating' ? state.total : state.files.length

  return (
    <Box>
      <Box flexDirection="row">
        <Text bold>Genie</Text>
        <Text dim> › </Text>
        <Spinner type="dots" />
        <Text>
          {' '}
          {state._tag === 'Discovering' ? 'Discovering...' : `Generating ${processed}/${total}`}
        </Text>
        <Text dim>
          {' '}
          · /some/workspace/path (viewport: {viewport.columns}x{viewport.rows})
        </Text>
      </Box>
      <Text> </Text>
      <Box flexShrink={1}>
        <FileList files={state.files} />
      </Box>
      <Text> </Text>
      <Text dim>{'─'.repeat(40)}</Text>
      <Text>
        Processing... {processed}/{total}
      </Text>
    </Box>
  )
}

// =============================================================================
// Static scenarios (one-shot, for comparison)
// =============================================================================

const VerticalState = Schema.Union(
  Schema.TaggedStruct('Showing', { count: Schema.Number }),
  Schema.TaggedStruct('Interrupted', {}),
)
const VerticalAction = Schema.Union(Schema.TaggedStruct('Interrupted', {}))
const verticalReducer = ({
  state,
  action,
}: {
  state: typeof VerticalState.Type
  action: typeof VerticalAction.Type
}) => {
  if (action._tag === 'Interrupted') return { _tag: 'Interrupted' as const }
  return state
}

const VerticalView = ({ stateAtom }: { stateAtom: Atom.Atom<typeof VerticalState.Type> }) => {
  const state = useTuiAtomValue(stateAtom)
  const viewport = useViewport()
  if (state._tag === 'Interrupted') return <Text color="yellow">⚠ Cancelled</Text>
  return (
    <Box flexDirection="column">
      <Text bold>
        Vertical Overflow Test ({state.count} items, viewport: {viewport.columns}x{viewport.rows})
      </Text>
      <Text> </Text>
      {Array.from({ length: state.count }, (_, i) => (
        <Text key={i}> Line {String(i + 1).padStart(3, '0')}: item content here</Text>
      ))}
      <Text> </Text>
      <Text dim>{'─'.repeat(40)}</Text>
      <Text>Summary: rendered {state.count} items</Text>
    </Box>
  )
}

const CombinedView = ({ stateAtom }: { stateAtom: Atom.Atom<typeof VerticalState.Type> }) => {
  const state = useTuiAtomValue(stateAtom)
  const viewport = useViewport()
  if (state._tag === 'Interrupted') return <Text color="yellow">⚠ Cancelled</Text>
  return (
    <Box flexDirection="column">
      <Text bold>
        Combined Overflow Test ({state.count} items, viewport: {viewport.columns}x{viewport.rows})
      </Text>
      <Text> </Text>
      {Array.from({ length: state.count }, (_, i) => (
        <Text key={i}>
          {i % 3 === 0 ? '✗' : '✓'} packages/@overeng/package-{i}
          /very-long-path-to-config-file.json
          {i % 3 === 0
            ? ' error: Failed to generate — some lengthy error message explaining the problem'
            : ''}
        </Text>
      ))}
      <Text> </Text>
      <Text dim>{'─'.repeat(40)}</Text>
      <Text>
        Processed {state.count} files: {state.count - Math.floor(state.count / 3)} ok,{' '}
        {Math.floor(state.count / 3)} failed
      </Text>
    </Box>
  )
}

// =============================================================================
// Command Logic
// =============================================================================

const runFooter = (fileCount: number, delayMs: number) =>
  Effect.gen(function* () {
    const files = Array.from({ length: fileCount }, (_, i) => ({
      name: `packages/@overeng/pkg-${i}/config.json`,
      status: 'pending',
    }))

    const App = createTuiApp({
      stateSchema: AppState,
      actionSchema: AppAction,
      initial: { _tag: 'Discovering', files } as AppState,
      reducer: appReducer,
    })

    const tui = yield* App.run(<StressView stateAtom={App.stateAtom} />)

    // Phase 1: Discovery
    yield* Effect.sleep('200 millis')

    // Phase 2: Start generating
    tui.dispatch({ _tag: 'StartGenerating' })
    yield* Effect.sleep('100 millis')

    // Phase 3: Process files one by one
    for (let i = 0; i < fileCount; i++) {
      tui.dispatch({ _tag: 'MarkActive', index: i })
      yield* Effect.sleep(`${delayMs} millis`)

      const status: FileStatus = i % 5 === 0 ? 'error' : i % 3 === 0 ? 'unchanged' : 'ok'
      tui.dispatch({ _tag: 'ProcessFile', index: i, status })
    }

    // Phase 4: Complete — dispatch and give one render cycle before scope closes
    tui.dispatch({ _tag: 'Finish' })
    yield* Effect.sleep('50 millis')
  }).pipe(Effect.scoped)

const runStatic = (mode: 'vertical' | 'combined', count: number) =>
  Effect.gen(function* () {
    const App = createTuiApp({
      stateSchema: VerticalState,
      actionSchema: VerticalAction,
      initial: { _tag: 'Showing', count } as typeof VerticalState.Type,
      reducer: verticalReducer,
    })

    const View = mode === 'vertical' ? VerticalView : CombinedView
    yield* App.run(<View stateAtom={App.stateAtom} />)

    // Just show for a moment then exit
    yield* Effect.sleep('500 millis')
  }).pipe(Effect.scoped)

// =============================================================================
// CLI
// =============================================================================

// Parse args manually (positional args conflict with @effect/cli's argument parser)
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const mode = args[0] ?? 'footer'
const count = parseInt(args[1] ?? '80', 10)
const delayMs = parseInt(args[2] ?? '30', 10)

const program = Effect.gen(function* () {
  switch (mode) {
    case 'vertical':
    case 'combined':
      yield* runStatic(mode, count)
      break
    case 'footer':
    default:
      yield* runFooter(count, delayMs)
      break
  }
}).pipe(Effect.provide(outputModeLayer('tty')))

program.pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
