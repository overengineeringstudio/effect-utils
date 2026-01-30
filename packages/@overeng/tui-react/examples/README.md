# tui-react Examples

This directory contains examples demonstrating various features of tui-react.

## Example Structure

For reusability with Storybook, examples follow a **Split View + Logic** pattern:

```
examples/02-components/task-list/
├── schema.ts         # State/Action schemas (reusable)
├── reducer.ts        # Reducer logic (reusable)
├── view.tsx          # View component (reusable)
├── cli.tsx           # CLI entry point (Node-specific)
├── mod.ts            # Re-exports
└── task-list.stories.tsx  # Storybook stories
```

### Why This Structure?

1. **Reusability**: View components can be rendered in both CLI and Storybook
2. **Testing**: Schemas and reducers can be unit tested independently
3. **Storybook**: `TuiStoryPreview` can simulate state without running the CLI
4. **Separation of Concerns**: Business logic (reducer) is separate from rendering (view)

## Running Examples

All examples can be run with Bun:

```bash
# Basic examples
bun examples/01-basic/hello-world.tsx
bun examples/01-basic/hello-world.tsx --output json
bun examples/01-basic/hello-world.tsx --output tty   # Force TTY mode

# CLI examples
bun examples/03-cli/deploy/main.ts --services api --dry-run
bun examples/03-cli/deploy/main.ts --services api --dry-run --output json
bun examples/03-cli/deploy/main.ts --services api --dry-run --output log

# Effect integration examples
bun examples/02-effect-integration/counter.tsx
bun examples/02-effect-integration/counter.tsx --output json
```

## Output Modes

All CLI examples use the `--output` / `-o` flag:

| Mode         | Timing | Description                        |
| ------------ | ------ | ---------------------------------- |
| `auto`       | -      | Auto-detect from environment       |
| `tty`        | live   | Interactive terminal (default)     |
| `ci`         | live   | CI with colors                     |
| `ci-plain`   | live   | CI without colors                  |
| `pipe`       | final  | Final output with colors           |
| `log`        | final  | Final output without colors        |
| `json`       | final  | Single JSON output at completion   |
| `ndjson`     | live   | Streaming NDJSON                   |
| `alt-screen` | live   | Fullscreen TUI                     |

## Creating a New Example

### 1. Define Schemas (`schema.ts`)

```typescript
import { Schema } from 'effect'

// State schema - must be a tagged union
export const AppState = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal('Running'), count: Schema.Number }),
  Schema.Struct({ _tag: Schema.Literal('Finished'), result: Schema.String }),
)
export type AppState = typeof AppState.Type

// Action schema
export const AppAction = Schema.Union(
  Schema.TaggedStruct('Increment', {}),
  Schema.TaggedStruct('Finish', {}),
)
export type AppAction = typeof AppAction.Type
```

### 2. Implement Reducer (`reducer.ts`)

```typescript
import type { AppState, AppAction } from './schema.ts'

export const appReducer = ({ state, action }: { state: AppState; action: AppAction }): AppState => {
  switch (action._tag) {
    case 'Increment':
      if (state._tag !== 'Running') return state
      return { ...state, count: state.count + 1 }
    case 'Finish':
      if (state._tag !== 'Running') return state
      return { _tag: 'Finished', result: `Count was ${state.count}` }
  }
}
```

### 3. Create View Component (`view.tsx`)

```typescript
import React from 'react'
import { Box, Text } from '../../../src/mod.ts'
import type { AppState } from './schema.ts'

export const AppView: React.FC<{ state: AppState }> = ({ state }) => {
  switch (state._tag) {
    case 'Running':
      return <Text>Count: {state.count}</Text>
    case 'Finished':
      return <Text color="green">{state.result}</Text>
  }
}
```

### 4. Create CLI Entry Point (`cli.tsx`)

```typescript
import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import React from 'react'

import { createTuiApp, outputOption, outputModeLayer } from '../../../src/mod.ts'
import { AppState, AppAction } from './schema.ts'
import { appReducer } from './reducer.ts'
import { AppView } from './view.tsx'

const runApp = Effect.gen(function* () {
  const App = createTuiApp({
    stateSchema: AppState,
    actionSchema: AppAction,
    initial: { _tag: 'Running', count: 0 } as AppState,
    reducer: appReducer,
  })

  const MainView = () => <AppView state={App.useState()} />
  const tui = yield* App.run(<MainView />)

  // Business logic here...
  tui.dispatch({ _tag: 'Increment' })
  yield* Effect.sleep('1 second')
  tui.dispatch({ _tag: 'Finish' })
}).pipe(Effect.scoped)

const command = Command.make('my-app', { output: outputOption }, ({ output }) =>
  runApp.pipe(Effect.provide(outputModeLayer(output))),
)

Command.run(command, { name: 'my-app', version: '1.0.0' })(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
```

### 5. Create Storybook Stories (`*.stories.tsx`)

```typescript
import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { TuiStoryPreview } from '../../../src/storybook/TuiStoryPreview.tsx'
import { AppState, AppAction } from './schema.ts'
import { appReducer } from './reducer.ts'
import { AppView } from './view.tsx'

const meta: Meta = {
  title: 'Examples/My App',
  parameters: { layout: 'fullscreen' },
}
export default meta

// Timeline simulates CLI execution
const timeline: Array<{ at: number; action: typeof AppAction.Type }> = [
  { at: 0, action: { _tag: 'Increment' } },
  { at: 500, action: { _tag: 'Increment' } },
  { at: 1000, action: { _tag: 'Finish' } },
]

export const Demo: StoryObj = {
  render: () => (
    <TuiStoryPreview
      View={AppView}
      stateSchema={AppState}
      actionSchema={AppAction}
      reducer={appReducer}
      initialState={{ _tag: 'Running', count: 0 }}
      timeline={timeline}
      autoRun={true}
    />
  ),
}
```

## TuiStoryPreview Features

The `TuiStoryPreview` component provides:

- **Tabs**: TTY | Alt Screen | CI | CI Plain | Pipe | Log | JSON | NDJSON
- **Timeline Playback**: Play/Pause/Scrub through state changes
- **State Simulation**: Reducer runs in browser (no CLI needed)
- **Storybook Controls**: `autoRun`, `playbackSpeed`, `height`

```tsx
<TuiStoryPreview
  View={MyView}
  stateSchema={StateSchema}
  actionSchema={ActionSchema}
  reducer={myReducer}
  initialState={initialState}
  timeline={[
    { at: 0, action: { _tag: 'Start' } },
    { at: 1000, action: { _tag: 'Finish' } },
  ]}
  autoRun={true}
  playbackSpeed={1}
  height={400}
/>
```

## Directory Overview

```
examples/
├── 01-basic/
│   └── hello-world.tsx          # Simplest example with countdown
│
├── 02-components/
│   ├── task-list/               # Split structure example
│   │   ├── schema.ts
│   │   ├── reducer.ts
│   │   ├── view.tsx
│   │   ├── cli.tsx
│   │   └── task-list.stories.tsx
│   └── ...
│
├── 03-effect-integration/
│   └── counter.tsx              # Effect CLI integration
│
├── 04-cli/
│   └── deploy/                  # Full-featured CLI example
│       └── ...
│
└── README.md                    # This file
```
