# tui-react Specification

> Terminal UI rendering for Effect-based CLI commands.

## Overview

CLI commands need to output to different contexts: interactive terminals, CI pipelines, scripted automation. This spec defines how commands expose state and how renderers consume it, enabling a single command implementation to work across all output modes.

**Core insight:** Decouple command logic from rendering by making state explicit and observable.

---

## Principles

### P1: State-First Design

Commands model state explicitly using Effect Schema. State is the single source of truth for all renderers.

### P2: Renderer-Agnostic Commands

Command implementation does not know which renderer will display output. Commands produce state; renderers consume it.

### P3: Schema-Driven Data

All state and events are defined with Effect Schema. JSON output uses `Schema.encode`, not `JSON.stringify`.

### P4: Bidirectional Communication

State flows down (command → renderer). Events flow up (renderer → command).

### P5: Modal Consistency

Output stays within its modality. JSON mode outputs only JSON, even for errors.

### P6: Graceful Degradation

Progressive rendering falls back to final output in non-TTY environments. Interactive falls back to passive.

### P7: Semantic Over Visual

JSON output represents semantic domain data, not visual structure.

---

## Output Model

### Dimensions

Output behavior is determined by a `RenderConfig` with these properties:

| Property      | Values           | Description                                      |
| ------------- | ---------------- | ------------------------------------------------ |
| **timing**    | `live` / `final` | Updates over time vs single output at completion |
| **animation** | `true` / `false` | Whether spinners/progress animate                |
| **colors**    | `true` / `false` | Whether ANSI color codes are used                |
| **altScreen** | `true` / `false` | Full-screen takeover vs inline                   |

### Named Modes

| Mode         | Timing | Animation | Colors | Alt Screen | Use Case                       |
| ------------ | ------ | --------- | ------ | ---------- | ------------------------------ |
| `tty`        | live   | ✓         | ✓      | ✗          | Interactive terminal (default) |
| `alt-screen` | live   | ✓         | ✓      | ✓          | Fullscreen TUI, dashboards     |
| `ci`         | live   | ✗         | ✓      | ✗          | CI with colors                 |
| `ci-plain`   | live   | ✗         | ✗      | ✗          | CI without colors              |
| `pipe`       | final  | ✗         | ✓      | ✗          | Piping to another command      |
| `log`        | final  | ✗         | ✗      | ✗          | Log files, plain output        |
| `json`       | final  | -         | -      | -          | Final JSON for scripting       |
| `ndjson`     | live   | -         | -      | -          | Streaming NDJSON               |

**Auto-detection:** When `--output auto` (the default), the mode is detected from the environment:

- TTY → `tty`
- Non-TTY (piped) → `pipe`
- `CI=true` environment variable → `ci`
- `NO_COLOR` environment variable → removes colors from detected mode

---

## Mode Specifications

### `tty` (Live Visual)

Real-time visual updates within terminal scrollback. This is the default mode for interactive terminals.

**Use cases:** Progress bars, sync status, build output

**Requirements:**

- Render updates as state changes (subscribe to `state.changes`)
- Support static region for persistent logs above dynamic content
- Throttle renders to prevent terminal flooding (default: 16ms / ~60fps)
- Limit dynamic region height (`maxDynamicLines`) to prevent runaway output
- Hide cursor during rendering, restore on exit
- Use synchronized output (CSI 2026) to prevent flicker

**Constraints:**

- No input handling (passive mode)
- Output height is unbounded but should be reasonable (< 100 lines typical)
- Exit behavior controlled by `ExitMode` (see [Exit Behavior](#exit-behavior))
- Static content cannot be "unwritten" once rendered

**Degradation:**

- Non-TTY → Falls back to `pipe` mode

**Example output:**

```
[deploy] Validating configuration...   ← Static
[deploy] Configuration valid           ← Static
● Deploying 2/4 services               ← Dynamic (updates in place)
  ✓ api-server (healthy)
  ◐ web-client (starting)
```

---

### `alt-screen` (Fullscreen TUI)

Full-screen interactive application using alternate screen buffer. **Implemented via [OpenTUI](https://github.com/anomalyco/opentui)**.

> See [OpenTUI Research](./research/opentui.md) for integration details.

**Use cases:** Dashboards, file browsers, interactive selection

**Runtime Requirements:**

- **Bun runtime required** - OpenTUI uses `bun-ffi-structs` for native bindings
- **Prebuilt binaries available** - No Zig compiler needed for end users
- Install: `bun add @opentui/core @opentui/react`

**Requirements:**

- Enter alternate screen buffer on start, exit on unmount
- Render to fixed viewport dimensions (full terminal)
- Handle keyboard input via `useKeyboard` hook → publish `KeyEvent` to command
- Handle terminal resize via `useOnResize` hook → publish `ResizeEvent` to command
- Support focus management for interactive elements
- Bridge OpenTUI events to Effect PubSub

**Implementation:**

```typescript
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useOnResize } from "@opentui/react"

// Create full-screen renderer
const renderer = await createCliRenderer({ exitOnCtrlC: true })

// Render app with state/event bindings
createRoot(renderer).render(
  <Dashboard state={commandState} events={commandEvents} />
)
```

**tui-react Integration:**

OpenTUI integration is handled automatically by `useTuiState` when the output mode is `alt-screen`. The mode automatically falls back to `tty` if OpenTUI is not available (Node.js runtime).

```typescript
// useTuiState handles renderer selection based on OutputMode
const tui =
  yield *
  useTuiState({
    stateSchema: DashboardState,
    actionSchema: DashboardAction,
    initial: { _tag: 'Idle' },
    reducer: dashboardReducer,
    View: DashboardView,
  })

// For low-level control, use useOpenTuiRenderer directly:
import { useOpenTuiRenderer, isOpenTuiAvailable } from '@overeng/tui-react'

if (isOpenTuiAvailable()) {
  yield *
    useOpenTuiRenderer({
      View: DashboardView,
      stateAtom,
      dispatch,
      eventPubSub,
    })
}
```

**Constraints:**

- Requires TTY (cannot work in pipes)
- **Requires Bun runtime** (not Node.js)
- Must restore original screen on exit (normal or error)
- No scrollback (alternate buffer is isolated)
- Single viewport, no static/dynamic split
- Different component set than inline mode (OpenTUI components)

**Automatic Fallback:**
When `alt-screen` mode is requested but OpenTUI is not available (Node.js runtime), it automatically falls back to `tty` mode. No manual handling required:

```typescript
// Request alt-screen mode - automatically falls back if not available
runDeploy(services).pipe(Effect.provide(altScreenLayer))
// In Node.js: uses tty (inline) rendering
// In Bun with OpenTUI: uses alternate screen
```

**Additional degradation:**

- Non-TTY → Falls back to `pipe`
- Non-interactive flag → Falls back to `tty`

**Cleanup requirements (handled by OpenTUI):**

- Exit alternate screen buffer
- Restore cursor visibility
- Restore terminal modes (raw mode off)
- Exit behavior controlled by `ExitMode` (see [Exit Behavior](#exit-behavior))

---

### `ci` and `ci-plain` (CI Modes)

Live visual output optimized for CI environments.

**Use cases:** GitHub Actions, Jenkins, other CI pipelines

| Mode       | Colors | Animation | Description                    |
| ---------- | ------ | --------- | ------------------------------ |
| `ci`       | ✓      | ✗         | CI with ANSI colors            |
| `ci-plain` | ✗      | ✗         | CI without colors (plain text) |

**Requirements:**

- Live updates (timing: `live`)
- No cursor manipulation or screen clearing
- No spinners (animation disabled)
- `ci`: Respects ANSI colors for CI systems that support them
- `ci-plain`: Plain text only, respects `NO_COLOR` env

**Auto-detection:** When `CI=true` environment variable is set and `--output auto`, the `ci` mode is selected.

---

### `pipe` and `log` (Final Visual)

Single visual output rendered at command completion.

**Use cases:** Piping to other commands, log files, non-TTY environments

| Mode   | Colors | Description                                    |
| ------ | ------ | ---------------------------------------------- |
| `pipe` | ✓      | Final output with colors (for `less -R`, etc.) |
| `log`  | ✗      | Final output without colors (plain text)       |

**Requirements:**

- Wait for command completion (final state)
- Render final state once to stdout
- No cursor manipulation or screen clearing
- `pipe`: Keeps ANSI colors for tools that support them
- `log`: Plain output, no ANSI codes

**Constraints:**

- No progress updates during execution
- No input handling
- No dynamic re-rendering
- Output is append-only (like normal stdout)

**Auto-detection:** When stdout is not a TTY (piped), the `pipe` mode is selected.

**Example output:**

```
Deploy complete:
  ✓ api-server (updated, 1.2s)
  ✓ web-client (unchanged)
  ✓ worker (updated, 0.8s)

3 services deployed in 3.4s
```

---

### `json` (Final JSON)

Structured JSON output at command completion.

**Use cases:** Scripting, CI integration, tool chaining (`jq`, etc.)

**Requirements:**

- Wait for command completion (final state)
- Output single JSON object to stdout
- Use `Schema.encode` for serialization (not `JSON.stringify` on raw state)
- Include `_tag` field for discriminated union types

**Constraints:**

- **Strict JSON only:** No plain text, no ANSI codes, no progress
- **Single output:** Exactly one JSON object (or array) per invocation
- **Errors as JSON:** Errors must be output as JSON, not plain text
- **No stderr mixing:** Avoid stderr for errors; encode in JSON response
- **Newline terminated:** Output ends with `\n` for proper piping

**Error format:**

```json
{
  "_tag": "Error",
  "code": "DEPLOY_FAILED",
  "message": "Failed to deploy service",
  "details": { "service": "api-server", "reason": "Health check timeout" }
}
```

**Success format:**

```json
{
  "_tag": "Deploy.Complete",
  "services": [
    { "name": "api-server", "result": "updated", "duration": 1024 },
    { "name": "web-client", "result": "unchanged", "duration": 0 },
    { "name": "worker", "result": "updated", "duration": 812 }
  ],
  "totalDuration": 3421
}
```

---

### `ndjson` (Streaming JSON)

Streaming JSON output (NDJSON format) as state changes.

**Use cases:** Real-time monitoring, log aggregation, streaming to other tools

**Requirements:**

- Output one JSON object per line as state changes
- Each line is valid JSON (NDJSON format)
- Use `Schema.encode` for each state emission
- Flush after each line for real-time streaming

**Implementation Note:** The stream subscription MUST be established before `useTuiState` returns to guarantee the initial state is emitted. This is handled internally by `useTuiState`.

**Constraints:**

- **Strict JSON only:** Every line must be valid JSON
- **No buffering:** Flush immediately after each JSON line
- **Newline delimited:** Each JSON object on its own line
- **Errors as JSON:** Errors are JSON objects in the stream, not plain text
- **No mixed output:** Never mix plain text with JSON lines

**Stream format:**

```
{"_tag":"Deploy.Validating"}
{"_tag":"Deploy.Progress","service":"api-server","phase":"pulling"}
{"_tag":"Deploy.Progress","service":"api-server","phase":"starting"}
{"_tag":"Deploy.Progress","service":"api-server","phase":"healthy"}
{"_tag":"Deploy.Progress","service":"web-client","phase":"pulling"}
{"_tag":"Deploy.Complete","services":[...],"duration":3421}
```

**Error in stream:**

```
{"_tag":"Deploy.Progress","service":"api-server","phase":"healthcheck"}
{"_tag":"Error","code":"HEALTH_CHECK_FAILED","message":"Service failed health check after 3 attempts"}
```

---

## Data Flow

### Architecture

State management uses Effect Atom (`@effect-atom/atom`) with an Elm-style reducer pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Command Logic                             │
│                        (Effect.gen)                              │
│                                                                  │
│   tui.dispatch({ _tag: 'SetProgress', services: [...] })        │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                    yield* useTuiState({...})
                                │
                                ▼
                    ┌───────────────────────────────┐
                    │         TuiStateAtom          │
                    │                               │
                    │   stateAtom ◀── reducer(s,a) │
                    │       │                       │
                    │       ▼                       │
                    │   useAtomValue()              │
                    │                               │
                    │   actionStream ──▶ command   │
                    │       ▲                       │
                    │       │                       │
                    │   dispatch(action)            │
                    └───────────────┬───────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
          ┌─────────────────┐           ┌─────────────────┐
          │  Visual Modes   │           │   JSON Modes    │
          │  (React render) │           │  (Schema.encode)│
          └─────────────────┘           └─────────────────┘
```

### State (Command → Renderer)

Commands define state and actions using Effect Schema, then use a pure reducer:

```typescript
import { Schema } from 'effect'

// State schema (tagged union)
const DeployState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Validating', {}),
  Schema.TaggedStruct('Progress', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literal('pending', 'pulling', 'starting', 'healthy', 'failed'),
      }),
    ),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        result: Schema.Literal('updated', 'unchanged', 'rolled-back'),
        duration: Schema.Number,
      }),
    ),
    totalDuration: Schema.Number,
  }),
)

// Action schema (tagged union)
const DeployAction = Schema.Union(
  Schema.TaggedStruct('StartValidation', {}),
  Schema.TaggedStruct('SetServices', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        status: Schema.Literal('pending', 'pulling', 'starting', 'healthy', 'failed'),
      }),
    ),
  }),
  Schema.TaggedStruct('UpdateService', {
    name: Schema.String,
    status: Schema.Literal('pending', 'pulling', 'starting', 'healthy', 'failed'),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        result: Schema.Literal('updated', 'unchanged', 'rolled-back'),
        duration: Schema.Number,
      }),
    ),
    totalDuration: Schema.Number,
  }),
)

// Pure reducer function
const deployReducer = (state: DeployState, action: DeployAction): DeployState => {
  switch (action._tag) {
    case 'StartValidation':
      return { _tag: 'Validating' }
    case 'SetServices':
      return { _tag: 'Progress', services: action.services }
    case 'UpdateService':
      if (state._tag !== 'Progress') return state
      return {
        ...state,
        services: state.services.map((s) =>
          s.name === action.name ? { ...s, status: action.status } : s,
        ),
      }
    case 'Complete':
      return { _tag: 'Complete', services: action.services, totalDuration: action.totalDuration }
  }
}
```

Renderers receive state via Effect Atom's `useAtomValue` hook.

### Events (Renderer → Command)

Renderers publish input events via `PubSub`:

```typescript
import { Schema, PubSub } from 'effect'

const KeyEvent = Schema.TaggedStruct('Event.Key', {
  key: Schema.String,
  ctrl: Schema.optional(Schema.Boolean),
  alt: Schema.optional(Schema.Boolean),
  shift: Schema.optional(Schema.Boolean),
})

const ResizeEvent = Schema.TaggedStruct('Event.Resize', {
  rows: Schema.Number,
  cols: Schema.Number,
})

const InputEvent = Schema.Union(KeyEvent, ResizeEvent)
```

Commands subscribe to events and dispatch actions to update state.

**Important:** When creating an event PubSub for interactive commands, use the `replay` option to ensure late subscribers don't miss events:

```typescript
// Create PubSub with replay buffer for late subscribers
const eventPubSub = yield * PubSub.unbounded<InputEvent>({ replay: 16 })

// Subscribe to events - receives last 16 events plus new ones
const events = yield * PubSub.subscribe(eventPubSub)
```

### TuiStateApi Interface

The API returned by `useTuiState`:

```typescript
interface TuiStateApi<S, A> {
  /** Dispatch an action to update state (sync, fire-and-forget) */
  readonly dispatch: (action: A) => void

  /** Get current state synchronously */
  readonly getState: () => S

  /** State atom for derived state or advanced use */
  readonly stateAtom: Atom.Atom<S>

  /** Action stream for command-side effects (subscribe to user interactions) */
  readonly actions: Stream.Stream<A>
}
```

**Note:** `dispatch` is synchronous and returns `void`, not `Effect<void>`. This makes UI updates simpler and more natural.

---

## Mode Selection

### RenderConfig

The internal configuration that controls rendering behavior:

```typescript
interface RenderConfig {
  timing: 'live' | 'final'
  animation: boolean
  colors: boolean
  altScreen: boolean
}
```

### CLI Option

Commands use a single `--output` / `-o` flag to select the mode:

```bash
# Auto-detect from environment (default)
deploy                                 # TTY → tty
deploy                                 # Pipe → pipe
CI=true deploy                         # CI env → ci

# Explicit mode selection
deploy --output tty                    # Force TTY mode
deploy --output ci                     # CI with colors
deploy --output ci-plain               # CI without colors
deploy --output pipe                   # Final with colors
deploy --output log                    # Final without colors
deploy --output alt-screen             # Fullscreen TUI
deploy --output json                   # Final JSON
deploy --output ndjson                 # Streaming NDJSON

# Scripting integration
deploy --output json | jq '.services[]'    # Parse with jq
deploy --output ndjson | process-logs      # Stream processing
deploy --output log > deploy.log           # Log to file
```

### Available Modes

| Mode         | Use When                             |
| ------------ | ------------------------------------ |
| `auto`       | Default - detect from environment    |
| `tty`        | Interactive terminal with progress   |
| `alt-screen` | Fullscreen dashboard/TUI             |
| `ci`         | CI environment with color support    |
| `ci-plain`   | CI environment without colors        |
| `pipe`       | Piping to commands that support ANSI |
| `log`        | Writing to log files                 |
| `json`       | Machine-readable final output        |
| `ndjson`     | Machine-readable streaming output    |

### Validation & Fallbacks

- `alt-screen` + non-TTY → Falls back to `pipe`
- `tty` + non-TTY → Falls back to `pipe`
- `NO_COLOR` env → Disables colors in detected mode

---

## Rendering

### Inline Renderer (tui-react)

For `tty`, `ci`, `ci-plain`, `pipe`, and `log` modes.

Uses React with custom reconciler (`react-reconciler`) and Yoga for flexbox layout.

**Pipeline:**

```
React Tree → TuiReconciler → Yoga Layout → Lines → InlineRenderer → Terminal
```

**Key features:**

- Differential line rendering (only changed lines written)
- Static/dynamic regions (logs persist above progress)
- Synchronized output (CSI 2026) for flicker-free updates
- Automatic resize handling

### Alternate Renderer (OpenTUI)

For `alt-screen` mode.

Uses [OpenTUI](https://github.com/anomalyco/opentui) with its React reconciler (`@opentui/react`).

**Pipeline:**

```
React Tree → OpenTUI Reconciler → Yoga Layout → CliRenderer → Alternate Buffer
```

**Key features:**

- Full-screen alternate buffer
- Built-in keyboard handling (`useKeyboard`)
- Built-in resize handling (`useOnResize`, `useTerminalDimensions`)
- Focus management
- Animation support (`useTimeline`)

**Components:**

- `<box>` - Flexbox container with borders
- `<text>` - Styled text
- `<input>` - Text input
- `<select>` - Selection list
- `<scrollbox>` - Scrollable container

### createRoot API

```typescript
interface CreateRootOptions {
  /** Output stream (e.g., process.stdout) */
  output: NodeJS.WriteStream

  /** Min ms between renders. Default: 16 (~60fps) */
  throttleMs?: number

  /** Max lines for dynamic region. Default: 100 */
  maxDynamicLines?: number

  /** Max static lines to buffer. Default: Infinity */
  maxStaticLines?: number
}

const root = createRoot({ output: process.stdout })
root.render(<App />)
root.unmount()
```

### Viewport

Components access terminal dimensions via hook:

```typescript
const { columns, rows } = useViewport()
```

Viewport updates automatically on terminal resize.

### JSON Renderer

Uses `Schema.encode` for type-safe serialization:

```typescript
// Final JSON: single output at completion
state.changes.pipe(
  Stream.runLast,
  Effect.flatMap(Schema.encode(StateSchema)),
  Effect.flatMap((json) => Console.log(JSON.stringify(json))),
  Effect.orDie, // Encoding valid state should never fail
)

// Progressive JSON: NDJSON stream
state.changes.pipe(
  Stream.mapEffect((state) => Schema.encode(StateSchema)(state).pipe(Effect.orDie)),
  Stream.runForEach((json) => Console.log(JSON.stringify(json))),
)
```

**Note:** Use `Effect.orDie` for encoding because valid state (created from the same schema) should always encode successfully. If encoding fails, it indicates a programming error and should crash immediately rather than silently failing.

---

## Components

### Component Adapter Pattern

Components use an adapter pattern for renderer-agnostic code. The same component API works across inline and alternate modes.

```typescript
// Universal components auto-select renderer based on mode
import { Box, Text, Spinner, Static } from '@overeng/tui-react/universal'

// Or import renderer-specific directly
import { Box, Text, Spinner, Static } from '@overeng/tui-react' // inline
import { OBox, OText, OSpinner, OScrollBox } from '@overeng/tui-react/opentui' // alternate
```

### Core Elements

| Component     | Inline | Alternate | Purpose                                    |
| ------------- | ------ | --------- | ------------------------------------------ |
| `<Box>`       | ✓      | ✓         | Flexbox container                          |
| `<Text>`      | ✓      | ✓         | Styled text (color, bold, dim, etc.)       |
| `<Static>`    | ✓      | -         | Content that persists above dynamic region |
| `<Spinner>`   | ✓      | ✓         | Animated progress indicator                |
| `<ScrollBox>` | -      | ✓         | Scrollable container                       |
| `<Input>`     | -      | ✓         | Text input field                           |

### Capability Detection

```typescript
import { useCapability, IfCapability } from '@overeng/tui-react/universal'

function MyView({ state, dispatch }) {
  const hasScrollable = useCapability('scrollable')

  return (
    <Box>
      {/* Render different UI based on capabilities */}
      <IfCapability capability="static" fallback={<Text>Logs: {state.logs.length}</Text>}>
        <Static items={state.logs}>
          {log => <Text key={log.id} dim>{log.message}</Text>}
        </Static>
      </IfCapability>
    </Box>
  )
}
```

### Capability Matrix

| Capability   | Inline | Alternate | Description                                 |
| ------------ | ------ | --------- | ------------------------------------------- |
| `static`     | ✓      | -         | Persistent log region above dynamic content |
| `scrollable` | -      | ✓         | Scrollable containers                       |
| `input`      | -      | ✓         | Text input fields                           |
| `focus`      | -      | ✓         | Focus management                            |
| `alternate`  | -      | ✓         | Full-screen alternate buffer                |

### Static Region (Inline Only)

Content in `<Static>` is rendered once and persists in terminal scrollback:

```tsx
<>
  <Static items={logs}>
    {(log) => (
      <Text key={log.id} dim>
        [{log.time}] {log.message}
      </Text>
    )}
  </Static>
  <Box>
    <Spinner /> Processing...
  </Box>
</>
```

Output:

```
[14:23:01] Validating deployment     ← Static (persists)
[14:23:02] Deploying api-server...   ← Static (persists)
[14:23:03] api-server is healthy     ← Static (persists)
● Deploying web-client...            ← Dynamic (updates in place)
```

---

## Effect CLI Integration

tui-react integrates with `@effect/cli` rather than creating a parallel command system. Commands use standard Effect CLI patterns with tui-react providing rendering capabilities via Effect services.

### Core Pattern (Elm Architecture)

Commands follow the Elm architecture: **State + Action + Reducer + View**

```typescript
import * as Cli from '@effect/cli'
import { useTuiState, outputOption, outputModeLayer, Box, Text, Spinner } from '@overeng/tui-react'
import { Schema, Effect, Layer } from 'effect'

// 1. Define STATE schema (shared between visual and JSON modes)
const DeployState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Progress', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: Schema.Literal('pending', 'deploying', 'healthy'),
    })),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      result: Schema.Literal('updated', 'unchanged'),
      duration: Schema.Number,
    })),
    totalDuration: Schema.Number,
  }),
)
type DeployState = Schema.Schema.Type<typeof DeployState>

// 2. Define ACTION schema
const DeployAction = Schema.Union(
  Schema.TaggedStruct('StartDeploy', {
    services: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('UpdateService', {
    name: Schema.String,
    status: Schema.Literal('pending', 'deploying', 'healthy'),
  }),
  Schema.TaggedStruct('Finish', {
    results: Schema.Array(Schema.Struct({
      name: Schema.String,
      result: Schema.Literal('updated', 'unchanged'),
      duration: Schema.Number,
    })),
    totalDuration: Schema.Number,
  }),
)
type DeployAction = Schema.Schema.Type<typeof DeployAction>

// 3. Define pure REDUCER
const deployReducer = (state: DeployState, action: DeployAction): DeployState => {
  switch (action._tag) {
    case 'StartDeploy':
      return {
        _tag: 'Progress',
        services: action.services.map(name => ({ name, status: 'pending' as const })),
      }
    case 'UpdateService':
      if (state._tag !== 'Progress') return state
      return {
        ...state,
        services: state.services.map(s =>
          s.name === action.name ? { ...s, status: action.status } : s
        ),
      }
    case 'Finish':
      return {
        _tag: 'Complete',
        services: action.results,
        totalDuration: action.totalDuration,
      }
  }
}

// 4. Define React VIEW component
function DeployView({ state, dispatch, viewport }: TuiViewProps<DeployState, DeployAction>) {
  // state is the current value (not a ref!)
  // dispatch sends actions to update state

  if (state._tag === 'Idle') return null

  if (state._tag === 'Progress') {
    return (
      <Box flexDirection="column">
        <Box><Spinner /><Text> Deploying...</Text></Box>
        {state.services.map(s => (
          <Box key={s.name} paddingLeft={2}>
            {s.status === 'healthy' ? <Text color="green">✓</Text> : <Spinner />}
            <Text> {s.name}</Text>
          </Box>
        ))}
      </Box>
    )
  }

  return <Text color="green">✓ Deploy complete in {state.totalDuration}ms</Text>
}

// 5. Use in Effect CLI command with --output option
const deployCommand = Cli.Command.make(
  'deploy',
  { output: outputOption, services: servicesOption },
  ({ output, services }) =>
    Effect.gen(function* () {
      // Create TUI state with reducer
      const tui = yield* useTuiState({
        stateSchema: DeployState,
        actionSchema: DeployAction,
        initial: { _tag: 'Idle' },
        reducer: deployReducer,
        View: DeployView,
      })

      // Dispatch actions (sync, not Effect!)
      tui.dispatch({ _tag: 'StartDeploy', services: services.split(',') })

      // Do work and dispatch updates
      for (const service of services.split(',')) {
        tui.dispatch({ _tag: 'UpdateService', name: service, status: 'deploying' })
        yield* Effect.sleep('500 millis')
        tui.dispatch({ _tag: 'UpdateService', name: service, status: 'healthy' })
      }

      tui.dispatch({ _tag: 'Finish', results: [...], totalDuration: 1500 })
    }).pipe(
      Effect.scoped,
      Effect.provide(outputModeLayer(output))  // 'auto' | 'tty' | 'ci' | 'json' | etc.
    )
)
```

### createTuiApp

Factory for creating TUI applications with Elm-style state management. Returns an app instance with scoped hooks and run method.

```typescript
interface TuiAppConfig<S, A, SEncoded = S> {
  /** Schema for state (used for JSON serialization) */
  readonly stateSchema: Schema.Schema<S, SEncoded>
  /** Schema for actions - include 'Interrupted' variant to handle Ctrl+C */
  readonly actionSchema: Schema.Schema<A>
  /** Initial state value */
  readonly initial: S
  /** Pure reducer: (state, action) => newState */
  readonly reducer: (state: S, action: A) => S
  /** Optional: timeout for final render on interrupt (default: 500ms) */
  readonly interruptTimeout?: number
}

const createTuiApp: <S, A, SEncoded = S>(config: TuiAppConfig<S, A, SEncoded>) => TuiApp<S, A>
```

**TuiApp instance:**

```typescript
interface TuiApp<S, A> {
  /** Run the app with a view component */
  readonly run: (view: ReactElement) => Effect.Effect<TuiApi<S, A>, never, Scope.Scope | OutputMode>

  /** App-scoped hooks (for use in view components) - types inferred */
  readonly useState: () => S
  readonly useDispatch: () => (action: A) => void
}
```

**TuiApi (returned by run):**

```typescript
interface TuiApi<S, A> {
  /** Dispatch action (sync!) */
  readonly dispatch: (action: A) => void
  /** Get current state (sync) */
  readonly getState: () => S
  /** SubscriptionRef for reactive state access */
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>
  /** Action stream for side effects */
  readonly actions: Stream.Stream<A>
  /** Explicit unmount with exit mode */
  readonly unmount: (options?: { mode?: ExitMode }) => Effect.Effect<void>
}

type ExitMode = 'persist' | 'clear' | 'clearDynamic'
```

**App-scoped hooks** (types inferred automatically):

```typescript
const MyApp = createTuiApp({ stateSchema: MyState, ... })

const MyView = () => {
  const state = MyApp.useState()
  const dispatch = MyApp.useDispatch()

  return <Text>{state.count}</Text>
}
```

**Mode behavior:**

- `tty` / `ci` / `ci-plain`: Renders React component, re-renders on dispatch (live modes)
- `pipe` / `log`: Renders once at end (final visual modes)
- `json`: Outputs final state as JSON when scope closes
- `ndjson`: Streams state as NDJSON after each dispatch

**Interrupt handling:**
If `actionSchema` includes `Schema.TaggedStruct('Interrupted', {...})`, the system automatically dispatches it on Ctrl+C.

### OutputMode Service

```typescript
// The OutputMode type with render configuration
type OutputMode = {
  readonly _tag: string
  readonly config: RenderConfig
}

interface RenderConfig {
  timing: 'live' | 'final'
  animation: boolean
  colors: boolean
  altScreen: boolean
}

// Available mode names
type OutputModeValue =
  | 'auto'
  | 'tty'
  | 'alt-screen'
  | 'ci'
  | 'ci-plain'
  | 'pipe'
  | 'log'
  | 'json'
  | 'ndjson'

// Create layer from --output flag value
const outputModeLayer: (value: OutputModeValue) => Layer<OutputMode>

// Resolve mode directly (for testing)
const resolveOutputMode: (value: OutputModeValue) => OutputMode

// Detect mode from environment
const detectOutputMode: () => OutputMode
```

### Standard CLI Option

```typescript
import * as Cli from '@effect/cli'
import { outputOption, outputModeLayer } from '@overeng/tui-react'

// Standard --output / -o option (exported from tui-react)
// outputOption: Cli.Options<OutputModeValue>

// Use in command
const myCommand = Cli.Command.make(
  'mycommand',
  { output: outputOption /* other options */ },
  ({ output }) =>
    myEffect.pipe(
      Effect.provide(outputModeLayer(output)), // 'auto' by default
    ),
)
```

**Available mode values:**

- `auto` - Detect from environment (default)
- `tty` - Interactive terminal with animations
- `alt-screen` - Fullscreen TUI
- `ci` - CI with colors
- `ci-plain` - CI without colors
- `pipe` - Final output with colors
- `log` - Final output without colors
- `json` - Final JSON
- `ndjson` - Streaming NDJSON

---

## Complete Example

A full deploy command using Effect CLI with tui-react (Elm architecture):

```typescript
// deploy.ts
import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Schema, Duration } from 'effect'
import { useTuiState, outputOption, outputModeLayer, Box, Text, Spinner, Static, type TuiViewProps } from '@overeng/tui-react'

// ============================================================
// State Schema (shared between visual and JSON modes)
// ============================================================

const ServiceStatus = Schema.Literal('pending', 'deploying', 'healthy')
const ServiceResult = Schema.Literal('updated', 'unchanged')

const DeployState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Validating', {
    logs: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('Progress', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: ServiceStatus,
    })),
    logs: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      result: ServiceResult,
      duration: Schema.Number,
    })),
    logs: Schema.Array(Schema.String),
    totalDuration: Schema.Number,
  }),
)
type DeployState = Schema.Schema.Type<typeof DeployState>

// ============================================================
// Action Schema
// ============================================================

const DeployAction = Schema.Union(
  Schema.TaggedStruct('StartValidation', {}),
  Schema.TaggedStruct('AddLog', { message: Schema.String }),
  Schema.TaggedStruct('StartDeploy', {
    services: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('UpdateServiceStatus', {
    name: Schema.String,
    status: ServiceStatus,
  }),
  Schema.TaggedStruct('Finish', {
    results: Schema.Array(Schema.Struct({
      name: Schema.String,
      result: ServiceResult,
      duration: Schema.Number,
    })),
    totalDuration: Schema.Number,
  }),
)
type DeployAction = Schema.Schema.Type<typeof DeployAction>

// ============================================================
// Pure Reducer
// ============================================================

const deployReducer = (state: DeployState, action: DeployAction): DeployState => {
  const addLog = (s: DeployState, msg: string): DeployState => {
    if (!('logs' in s)) return s
    return { ...s, logs: [...s.logs, msg] }
  }

  switch (action._tag) {
    case 'StartValidation':
      return { _tag: 'Validating', logs: [] }

    case 'AddLog':
      return addLog(state, action.message)

    case 'StartDeploy':
      if (state._tag !== 'Validating') return state
      return {
        _tag: 'Progress',
        services: action.services.map(name => ({ name, status: 'pending' as const })),
        logs: state.logs,
      }

    case 'UpdateServiceStatus':
      if (state._tag !== 'Progress') return state
      return {
        ...state,
        services: state.services.map(s =>
          s.name === action.name ? { ...s, status: action.status } : s
        ),
      }

    case 'Finish':
      if (state._tag !== 'Progress') return state
      return {
        _tag: 'Complete',
        services: action.results,
        logs: state.logs,
        totalDuration: action.totalDuration,
      }
  }
}

// ============================================================
// React View Component
// ============================================================

function DeployView({ state, dispatch }: TuiViewProps<DeployState, DeployAction>) {
  if (state._tag === 'Idle') return null

  const logs = 'logs' in state ? state.logs : []

  return (
    <>
      <Static items={logs}>
        {(log, i) => <Text key={i} dim>[deploy] {log}</Text>}
      </Static>

      {state._tag === 'Validating' && (
        <Box>
          <Spinner type="dots" />
          <Text> Validating configuration...</Text>
        </Box>
      )}

      {state._tag === 'Progress' && (
        <Box flexDirection="column">
          <Text>Deploying {state.services.filter(s => s.status === 'healthy').length}/{state.services.length} services</Text>
          {state.services.map((service) => (
            <Box key={service.name} paddingLeft={2}>
              {service.status === 'healthy' && <Text color="green">✓ </Text>}
              {service.status === 'deploying' && <><Spinner type="dots" /><Text> </Text></>}
              {service.status === 'pending' && <Text dim>○ </Text>}
              <Text>{service.name}</Text>
              {service.status !== 'pending' && <Text dim> ({service.status})</Text>}
            </Box>
          ))}
        </Box>
      )}

      {state._tag === 'Complete' && (
        <Box flexDirection="column">
          <Text color="green">✓ Deploy complete</Text>
          {state.services.map((service) => (
            <Box key={service.name} paddingLeft={2}>
              <Text color="green">✓ </Text>
              <Text>{service.name}</Text>
              <Text dim> ({service.result}, {(service.duration / 1000).toFixed(1)}s)</Text>
            </Box>
          ))}
          <Text dim>{'\n'}{state.services.length} services deployed in {(state.totalDuration / 1000).toFixed(1)}s</Text>
        </Box>
      )}
    </>
  )
}

// ============================================================
// Command Logic (mode-agnostic)
// ============================================================

const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    const startTime = Date.now()

    // Create TUI state with reducer
    const tui = yield* useTuiState({
      stateSchema: DeployState,
      actionSchema: DeployAction,
      initial: { _tag: 'Idle' } as DeployState,
      reducer: deployReducer,
      View: DeployView,
    })

    // Phase 1: Validation
    tui.dispatch({ _tag: 'StartValidation' })
    tui.dispatch({ _tag: 'AddLog', message: 'Validating configuration...' })
    yield* Effect.sleep(Duration.millis(500))
    tui.dispatch({ _tag: 'AddLog', message: 'Configuration valid' })

    // Phase 2: Deploy services
    tui.dispatch({ _tag: 'StartDeploy', services })

    const results: Array<{ name: string; result: 'updated' as const; duration: number }> = []

    for (const service of services) {
      tui.dispatch({ _tag: 'AddLog', message: `Deploying ${service}...` })
      tui.dispatch({ _tag: 'UpdateServiceStatus', name: service, status: 'deploying' })

      const deployStart = Date.now()
      yield* Effect.sleep(Duration.millis(600 + Math.random() * 400))

      tui.dispatch({ _tag: 'AddLog', message: `${service} is healthy` })
      tui.dispatch({ _tag: 'UpdateServiceStatus', name: service, status: 'healthy' })

      results.push({ name: service, result: 'updated', duration: Date.now() - deployStart })
    }

    // Phase 3: Complete
    const totalDuration = Date.now() - startTime
    tui.dispatch({ _tag: 'AddLog', message: `Deploy complete in ${(totalDuration / 1000).toFixed(1)}s` })
    tui.dispatch({ _tag: 'Finish', results, totalDuration })

    return { services: results, totalDuration }
  }).pipe(Effect.scoped)

// ============================================================
// CLI Definition (standard @effect/cli)
// ============================================================

const servicesOption = Cli.Options.text('services').pipe(
  Cli.Options.withAlias('s'),
)

const deployCommand = Cli.Command.make(
  'deploy',
  { output: outputOption, services: servicesOption },
  ({ output, services }) =>
    Effect.gen(function* () {
      const serviceList = services.split(',').map(s => s.trim()).filter(Boolean)

      yield* runDeploy(serviceList).pipe(
        Effect.provide(outputModeLayer(output))
      )
    })
).pipe(Cli.Command.withDescription('Deploy services'))

// Root command with subcommands
const rootCommand = Cli.Command.make('mycli', {}).pipe(
  Cli.Command.withSubcommands([deployCommand]),
)

// Run CLI
Cli.Command.run(rootCommand, {
  name: 'mycli',
  version: '1.0.0',
})(process.argv).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
)
```

**Usage:**

```bash
# Auto-detect mode (default: tty for interactive terminal)
mycli deploy --services api,web,worker

# Explicit modes
mycli deploy --services api,web --output tty          # Interactive with animations
mycli deploy --services api,web --output ci           # CI with colors
mycli deploy --services api,web --output log          # Plain text for log files
mycli deploy --services api,web --output json         # Final JSON
mycli deploy --services api,web --output ndjson       # Streaming NDJSON
```

**Output in `tty` mode:**

```
[deploy] Validating configuration...
[deploy] Configuration valid
[deploy] Deploying api...
[deploy] api is healthy
Deploying 1/3 services
  ✓ api (healthy)
  ◐ web (deploying)
  ○ worker
```

**Output in `json` mode:**

```json
{
  "_tag": "Complete",
  "services": [
    { "name": "api", "result": "updated", "duration": 1024 },
    { "name": "web", "result": "updated", "duration": 892 }
  ],
  "logs": ["Validating...", "..."],
  "totalDuration": 2100
}
```

**Output in `ndjson` mode:**

```
{"_tag":"Validating","logs":["Validating configuration..."]}
{"_tag":"Progress","services":[{"name":"api","status":"deploying"}...],"logs":[...]}
{"_tag":"Progress","services":[{"name":"api","status":"healthy"}...],"logs":[...]}
{"_tag":"Complete","services":[...],"totalDuration":2100}
```

---

## Error Handling

### Error Types

```typescript
const CommandError = Schema.Union(
  Schema.TaggedStruct('CommandError.Validation', {
    message: Schema.String,
    field: Schema.optional(Schema.String),
  }),
  Schema.TaggedStruct('CommandError.Runtime', {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  }),
  Schema.TaggedStruct('CommandError.Cancelled', {
    reason: Schema.Literal('user', 'timeout', 'signal'),
  }),
)
```

### Error Flow

1. **Command errors** → Caught by runner, rendered according to mode
2. **Renderer errors** → Logged, attempt graceful degradation
3. **Cleanup errors** → Logged, but don't mask original error

```
Command throws → Runner catches → Mode-specific error output → Cleanup → Exit
```

### Mode-Specific Error Handling

| Mode            | Error Handling                                    |
| --------------- | ------------------------------------------------- |
| `tty`           | Clear dynamic region, print error, exit           |
| `alt-screen`    | Exit alternate screen, print error to main screen |
| `ci`/`ci-plain` | Print formatted error (with/without colors)       |
| `pipe`/`log`    | Print formatted error                             |
| `json`          | Output JSON error object                          |
| `ndjson`        | Output JSON error line, then close stream         |

### Error Output Examples

**Visual error:**

```
✗ Deploy failed

  Service "api-server" failed health check after 3 attempts.

  Last error: Connection refused on port 8080

  Rolled back: api-server, web-client
```

**JSON error:**

```json
{
  "_tag": "CommandError.Runtime",
  "message": "Service \"api-server\" failed health check",
  "cause": {
    "attempts": 3,
    "lastError": "Connection refused on port 8080"
  }
}
```

### Recovery Patterns

```typescript
// Automatic retry with backoff
const deployWithRetry = deploy.pipe(
  Command.retry({
    times: 3,
    backoff: 'exponential',
    when: (error) => error._tag === 'CommandError.Runtime',
  }),
)

// Manual recovery in command
run: (io) =>
  Effect.gen(function* () {
    const result = yield* deployService('api-server').pipe(
      Effect.catchTag('HealthCheckFailed', (error) =>
        Effect.gen(function* () {
          yield* log('Health check failed, attempting rollback...')
          yield* rollback('api-server')
          return { status: 'rolled-back' }
        }),
      ),
    )
  })
```

---

## Lifecycle & Signals

### Lifecycle Phases

```
Initialize → Setup Renderer → Run Command → Cleanup → Exit
    │              │              │            │
    └──────────────┴──────────────┴────────────┘
                   │
            Signal can interrupt any phase
```

### Signal Handling

Commands receive an `AbortSignal` via `CommandIO` for cooperative cancellation:

```typescript
run: (io) =>
  Effect.gen(function* () {
    for (const service of services) {
      // Check for cancellation
      if (io.signal.aborted) {
        yield* rollbackAll()
        return
      }

      yield* deployService(service)
    }
  })
```

### Cleanup Guarantees

The runner ensures cleanup runs even on:

- Normal completion
- Thrown errors
- SIGINT (Ctrl+C)
- SIGTERM
- Uncaught exceptions

```typescript
// Cleanup sequence
1. Set state to cancelling (if interrupted)
2. Wait for command to handle cancellation (with timeout)
3. Force abort if timeout exceeded
4. Run renderer cleanup (restore terminal)
5. Run command cleanup (if registered)
6. Exit with appropriate code
```

### Registering Cleanup

```typescript
run: (io) =>
  Effect.gen(function* () {
    // Acquire resources
    const connection = yield* DatabaseConnection.acquire()

    // Register cleanup
    yield* Effect.addFinalizer(() =>
      DatabaseConnection.release(connection).pipe(
        Effect.catchAll(() => Effect.void), // Don't fail cleanup
      ),
    )

    // Use resources
    yield* runMigrations(connection)
  })
```

### Terminal State Restoration

Renderers guarantee terminal restoration. The exact cleanup depends on the `ExitMode`:

| Renderer  | Base Cleanup                    | Default   | + `persist`         | + `clear`         | + `clearDynamic`           |
| --------- | ------------------------------- | --------- | ------------------- | ----------------- | -------------------------- |
| Inline    | Restore cursor, reset styles    | `persist` | Keep all output     | Clear all output  | Clear dynamic, keep static |
| Alternate | Exit alt buffer, restore cursor | `clear`   | Print final to main | No output to main | Same as `clear`            |
| JSON      | Flush buffer, trailing newline  | N/A       | N/A                 | N/A               | N/A                        |

### Exit Behavior

When a TUI program completes, the user controls what happens to the rendered output via `ExitMode`. This is specified at unmount time.

#### Exit Modes

| Mode           | Dynamic Region | Static Region | Use Case                               |
| -------------- | -------------- | ------------- | -------------------------------------- |
| `persist`      | Keep           | Keep          | Show final state or completion message |
| `clear`        | Clear          | Clear         | Clean exit, no trace left              |
| `clearDynamic` | Clear          | Keep          | Keep logs, remove progress UI          |

**Default behavior:**

- **Inline modes**: `persist` (final React render stays visible)
- **Alternate mode**: `clear` (returns to main buffer with no output)
- **JSON modes**: N/A (no visual to clean up)

> **Principle:** React renders everything, including the final state. The default `persist` mode keeps the final render visible as the command's output.

#### API

```typescript
// Let scope close - uses default mode
// Inline: persist (final render stays visible)
// Alternate: clear (returns to main buffer)

// Explicit unmount with different mode
yield * tui.unmount({ mode: 'clear' }) // Remove all output
yield * tui.unmount({ mode: 'clearDynamic' }) // Keep logs, clear final state
```

#### Expressing Final State Through React

The final output should be expressed through React. The view renders different states, and the final rendered state becomes the command's output.

**Standard Pattern: Transition to final state, React renders it**

```typescript
// State schema includes all possible final states
const DeployState = Schema.Union(
  Schema.TaggedStruct('Running', { progress: Schema.Number }),
  Schema.TaggedStruct('Complete', { summary: Schema.String }),
  Schema.TaggedStruct('Interrupted', {}),  // Reserved: system dispatches on Ctrl+C
  Schema.TaggedStruct('Error', { message: Schema.String }),
)

// Action schema - include Interrupted to handle Ctrl+C
const DeployAction = Schema.Union(
  Schema.TaggedStruct('SetProgress', { progress: Schema.Number }),
  Schema.TaggedStruct('Complete', { summary: Schema.String }),
  Schema.TaggedStruct('Interrupted', {}),  // Reserved: system dispatches on Ctrl+C
  Schema.TaggedStruct('SetError', { message: Schema.String }),
)

// Create the app
const DeployApp = createTuiApp({
  stateSchema: DeployState,
  actionSchema: DeployAction,
  initial: { _tag: 'Running', progress: 0 },
  reducer: deployReducer,
  interruptTimeout: 500,  // Optional: ms to wait for final render (default: 500)
})

// View uses app-scoped hooks - types inferred automatically
const DeployView = () => {
  const state = DeployApp.useState()
  const dispatch = DeployApp.useDispatch()

  switch (state._tag) {
    case 'Running':
      return <ProgressUI progress={state.progress} />
    case 'Complete':
      return <Text color="green">✓ {state.summary}</Text>
    case 'Interrupted':
      return <Text color="yellow">⚠ Operation cancelled</Text>
    case 'Error':
      return <Text color="red">✗ {state.message}</Text>
  }
}

// Program transitions to final state before exit
const program = Effect.gen(function* () {
  const tui = yield* DeployApp.run(<DeployView />)

  // ... do work ...

  // Transition to complete state - React renders it
  tui.dispatch({ _tag: 'Complete', summary: 'Deployed 3 services in 2.4s' })

  // Default persist: final render stays visible as output
}).pipe(Effect.scoped)
```

**App-scoped hooks** (types inferred from app definition):

```typescript
// Tuple pattern (recommended)
const [state, dispatch] = DeployApp.use()

// Or individual hooks
const state = DeployApp.useState()
const dispatch = DeployApp.useDispatch()
```

**With Static logs: Logs persist above final state**

```typescript
const DeployView = () => {
  const state = DeployApp.useState()

  return (
    <>
      {/* Static region: logs persist above */}
      <Static items={state.logs}>
        {(log, i) => <Text key={i} dim>{log}</Text>}
      </Static>

      {/* Dynamic region: current state */}
      {state._tag === 'Running' && <ProgressUI progress={state.progress} />}
      {state._tag === 'Complete' && <Text color="green">✓ {state.summary}</Text>}
      {state._tag === 'Interrupted' && <Text color="yellow">⚠ Cancelled</Text>}
    </>
  )
}
```

#### Sample Terminal Output

**Scenario: Deploy command with logs and progress**

During execution:

```
[10:15:01] Starting deployment to production    ← Static (log)
[10:15:01] Configuration validated              ← Static (log)
[10:15:02] Pulling api-server image             ← Static (log)
● Deploying 1/3 services                        ← Dynamic (current state)
  ✓ api-server (healthy)
  ◐ web-client (starting)
  ○ worker (pending)
```

**Normal exit with `persist`** (default - final React render stays visible):

```
[10:15:01] Starting deployment to production    ← Static logs persist
[10:15:01] Configuration validated
[10:15:02] Pulling api-server image
[10:15:05] Pulling web-client image
[10:15:08] All services deployed
✓ Deployed 3 services in 7.2s                   ← Final state rendered by React
$ _
```

**Interrupt (Ctrl+C) with `persist`** (default):

```
[10:15:01] Starting deployment to production
[10:15:01] Configuration validated
[10:15:02] Pulling api-server image
^C
⚠ Operation cancelled                          ← Interrupted state rendered by React
$ _
```

**Exit with `clearDynamic`** (keep logs, clear final state):

```
[10:15:01] Starting deployment to production    ← Static logs persist
[10:15:01] Configuration validated
[10:15:02] Pulling api-server image
[10:15:05] All services deployed
$ _                                             ← Dynamic region cleared
```

**Exit with `clear`** (remove all TUI output):

```
$ deploy --services api,web,worker
$ _                                             ← No output remains
```

#### Interrupt Handling (Ctrl+C)

Interruption is handled through Effect's built-in mechanisms. The system automatically dispatches an `Interrupted` action if your `ActionSchema` includes it.

**Convention: Reserved `Interrupted` tag**

If your `ActionSchema` includes `Schema.TaggedStruct('Interrupted', {...})`, the system automatically dispatches it on Ctrl+C:

```typescript
const MyAction = Schema.Union(
  Schema.TaggedStruct('SetProgress', { value: Schema.Number }),
  Schema.TaggedStruct('Complete', { summary: Schema.String }),
  Schema.TaggedStruct('Interrupted', {}), // ← System dispatches on Ctrl+C
)

// No extra config needed - system detects the Interrupted variant
const MyApp = createTuiApp({
  stateSchema: MyState,
  actionSchema: MyAction,
  initial: { _tag: 'Running' },
  reducer: myReducer,

  // Optional: timeout for final render (default: 500ms)
  interruptTimeout: 1000,
})
```

If `Interrupted` is not in your schema, Ctrl+C simply exits without dispatching an action.

**Custom payload** - include data in your Interrupted variant:

```typescript
Schema.TaggedStruct('Interrupted', {
  timestamp: Schema.Number,
  partialProgress: Schema.Number,
})
```

**How it works internally (using Effect's `onInterrupt`):**

```typescript
// System detects Interrupted variant in ActionSchema
const hasInterrupted = hasVariant(actionSchema, 'Interrupted')

// On Ctrl+C, Effect.onInterrupt runs uninterruptibly:
Effect.onInterrupt(() =>
  Effect.gen(function* () {
    if (hasInterrupted) {
      tui.dispatch({ _tag: 'Interrupted' })
      yield* waitForRender().pipe(
        Effect.timeout(config.interruptTimeout ?? 500),
        Effect.catchAll(() => Effect.void),
      )
    }
  }),
)
```

**Key behaviors:**

- `Effect.onInterrupt` runs **uninterruptibly** - cleanup completes before exit
- Timeout prevents hanging on slow renders
- Double Ctrl+C forces immediate exit (safety fallback)
- No `Interrupted` in schema → no action dispatched, just exits

**Error handling** is left to Effect's standard mechanisms:

```typescript
const program = Effect.gen(function* () {
  const tui = yield* MyApp.run(<MyView />)
  // ...
}).pipe(
  // User handles errors explicitly
  Effect.catchAll((error) =>
    Effect.gen(function* () {
      tui.dispatch({ _tag: 'SetError', message: String(error) })
      yield* Effect.sleep('100 millis')
    })
  )
)
```

#### Alternate Screen Mode

Alternate screen mode always returns to the main buffer when exiting (this is how terminal alternate screens work). The exit mode controls what gets printed to the main buffer after returning:

| Exit Mode      | Behavior                                               |
| -------------- | ------------------------------------------------------ |
| `persist`      | Print final rendered frame to main buffer, then return |
| `clear`        | Return to main buffer with no output                   |
| `clearDynamic` | Same as `clear` (no static region in alt mode)         |

**Example: Dashboard exits with `persist`**

```
# Before running (main buffer)
$ dashboard --monitor

# During execution (alternate screen - full terminal)
┌─────────────────────────────────────────┐
│  Service Monitor          [q] quit      │
├─────────────────────────────────────────┤
│  api-server    ● healthy    CPU: 12%    │
│  web-client    ● healthy    CPU: 8%     │
│  worker        ● healthy    CPU: 45%    │
└─────────────────────────────────────────┘

# After exit with 'persist' (returns to main buffer)
$ dashboard --monitor
Dashboard exited. All services healthy.       ← Final state printed
$ _
```

---

## Testing

### Testing Reducers (Unit)

Reducers are pure functions, easily testable without Effect:

```typescript
import { expect, test } from 'vitest'

test('reducer handles StartDeploy', () => {
  const state: DeployState = { _tag: 'Validating', logs: ['init'] }
  const action: DeployAction = { _tag: 'StartDeploy', services: ['api', 'web'] }

  const next = deployReducer(state, action)

  expect(next._tag).toBe('Progress')
  expect(next.services).toHaveLength(2)
  expect(next.services[0]).toEqual({ name: 'api', status: 'pending' })
})

test('reducer handles UpdateServiceStatus', () => {
  const state: DeployState = {
    _tag: 'Progress',
    services: [
      { name: 'api', status: 'pending' },
      { name: 'web', status: 'pending' },
    ],
    logs: [],
  }
  const action: DeployAction = { _tag: 'UpdateServiceStatus', name: 'api', status: 'healthy' }

  const next = deployReducer(state, action)

  expect(next.services[0]).toEqual({ name: 'api', status: 'healthy' })
  expect(next.services[1]).toEqual({ name: 'web', status: 'pending' })
})
```

### Testing Command Logic

Command logic is testable by collecting dispatched actions:

```typescript
import { expect, test } from 'vitest'
import { Effect, Layer, Stream, Chunk } from 'effect'
import { jsonLayer } from '@overeng/tui-react'

test('deploy command dispatches correct actions', async () => {
  const actions: DeployAction[] = []

  await Effect.gen(function* () {
    const tui = yield* useTuiState({
      stateSchema: DeployState,
      actionSchema: DeployAction,
      initial: { _tag: 'Idle' },
      reducer: deployReducer,
      View: DeployView,
    })

    // Collect actions in background
    yield* tui.actions.pipe(
      Stream.runCollect,
      Effect.map((chunk) => actions.push(...Chunk.toArray(chunk))),
      Effect.fork,
    )

    // Run the command
    yield* runDeployLogic(tui, ['api-server'])
  }).pipe(Effect.scoped, Effect.provide(jsonLayer), Effect.runPromise)

  // Assert action sequence
  expect(actions.map((a) => a._tag)).toContain('StartValidation')
  expect(actions.map((a) => a._tag)).toContain('StartDeploy')
  expect(actions.map((a) => a._tag)).toContain('Finish')
})
```

### Testing React Components

Use a test renderer with mock state and dispatch:

```typescript
import { TestRenderer } from '@overeng/tui-react/test'

test('deploy view renders progress correctly', () => {
  const renderer = TestRenderer.create()
  const state: DeployState = {
    _tag: 'Progress',
    services: [
      { name: 'api-server', status: 'healthy' },
      { name: 'web-client', status: 'deploying' },
    ],
    logs: [],
  }
  const dispatch = vi.fn()

  renderer.render(
    <DeployView state={state} dispatch={dispatch} viewport={{ columns: 80, rows: 24 }} />
  )

  expect(renderer.toText()).toContain('✓ api-server')
  expect(renderer.toText()).toContain('web-client')
})

test('view dispatches action on interaction', () => {
  const renderer = TestRenderer.create()
  const dispatch = vi.fn()

  renderer.render(
    <InteractiveView state={state} dispatch={dispatch} viewport={{ columns: 80, rows: 24 }} />
  )

  // Simulate interaction
  renderer.triggerEvent('keypress', { key: 'enter' })

  expect(dispatch).toHaveBeenCalledWith({ _tag: 'Confirm' })
})
```

### Snapshot Testing

```typescript
import { TestRenderer } from '@overeng/tui-react/test'

test('deploy complete view matches snapshot', () => {
  const renderer = TestRenderer.create({ columns: 80, rows: 24 })
  const state: DeployState = {
    _tag: 'Complete',
    services: [
      { name: 'api-server', result: 'updated', duration: 1024 },
      { name: 'web-client', result: 'unchanged', duration: 0 },
    ],
    logs: [],
    totalDuration: 1500,
  }

  renderer.render(
    <DeployView state={state} dispatch={() => {}} viewport={{ columns: 80, rows: 24 }} />
  )

  expect(renderer.toText()).toMatchSnapshot()
})
```

### Testing JSON Output

```typescript
import { Effect, Layer } from 'effect'
import { jsonLayer, captureConsole } from '@overeng/tui-react/test'

test('deploy produces valid JSON output', async () => {
  const { outputs } = await captureConsole(async () => {
    await runDeploy(['api-server']).pipe(Effect.provide(jsonLayer), Effect.runPromise)
  })

  // Validate JSON output against schema
  const result = Schema.decodeUnknownSync(DeployState)(JSON.parse(outputs[0]!))
  expect(result._tag).toBe('Complete')
})
```

### Test Utilities

```typescript
import { runTestCommand } from '@overeng/tui-react/test'

// Quick test helper that collects states and JSON output
const { states, actions, jsonOutput } = await runTestCommand({
  stateSchema: DeployState,
  actionSchema: DeployAction,
  initial: { _tag: 'Idle' },
  reducer: deployReducer,
  run: (tui) => runDeployLogic(tui, ['api', 'web']),
  mode: 'json',
})

expect(states).toHaveLength(5)
expect(actions.filter((a) => a._tag === 'AddLog')).toHaveLength(6)
expect(jsonOutput._tag).toBe('Complete')
```

---

## Effect Integration

tui-react integrates naturally with Effect's ecosystem since commands are standard Effect programs.

### Layer System

Commands can require services via Effect's Layer system:

```typescript
import * as Cli from '@effect/cli'
import { Layer, Context, Effect } from 'effect'
import { useTuiState, OutputMode, type TuiStateApi } from '@overeng/tui-react'

// Define service
class DeployService extends Context.Tag('DeployService')<
  DeployService,
  {
    deploy: (service: string) => Effect.Effect<void, DeployError>
    rollback: (service: string) => Effect.Effect<void, RollbackError>
    healthCheck: (service: string) => Effect.Effect<boolean>
  }
>() {}

// Command logic with TUI and services
const runDeployLogic = (tui: TuiStateApi<DeployState, DeployAction>, services: string[]) =>
  Effect.gen(function* () {
    const deployService = yield* DeployService

    tui.dispatch({ _tag: 'StartDeploy', services })

    for (const service of services) {
      tui.dispatch({ _tag: 'UpdateServiceStatus', name: service, status: 'deploying' })
      yield* deployService.deploy(service)
      yield* deployService.healthCheck(service)
      tui.dispatch({ _tag: 'UpdateServiceStatus', name: service, status: 'healthy' })
    }
  })

// Command setup
const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    const tui = yield* useTuiState({
      stateSchema: DeployState,
      actionSchema: DeployAction,
      initial: { _tag: 'Idle' },
      reducer: deployReducer,
      View: DeployView,
    })

    yield* runDeployLogic(tui, services)
  }).pipe(Effect.scoped)

// Provide layers when running
const deployCommand = Cli.Command.make(
  'deploy',
  { output: outputOption, services: servicesOption },
  ({ output, services }) =>
    runDeploy(services.split(',')).pipe(
      Effect.provide(outputModeLayer(output)),
      Effect.provide(DeployServiceLive),
    ),
)
```

### Logging Integration

Effect logs can be captured and displayed in the TUI Static region:

```typescript
import { Effect, Logger } from 'effect'
import { createTuiLogger, useTuiLogs } from '@overeng/tui-react'

const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    // Create TUI logger that captures Effect.log() calls
    const { logsRef, layer: loggerLayer } = yield* createTuiLogger({
      maxEntries: 100,
      logToConsole: false,
    })

    const tui = yield* useTuiState({
      stateSchema: DeployState,
      actionSchema: DeployAction,
      initial: { _tag: 'Idle' },
      reducer: deployReducer,
      View: (props) => <DeployView {...props} logsRef={logsRef} />,
    })

    // Run with logger layer - Effect.log() calls appear in TUI
    yield* Effect.gen(function* () {
      yield* Effect.log('Starting deployment')
      tui.dispatch({ _tag: 'StartDeploy', services })

      for (const service of services) {
        yield* Effect.logDebug(`Deploying ${service}`)
        tui.dispatch({ _tag: 'UpdateServiceStatus', name: service, status: 'deploying' })
        // ... deploy logic
      }
    }).pipe(Effect.provide(loggerLayer))
  }).pipe(Effect.scoped)

// In View component
function DeployView({ state, dispatch, logsRef }) {
  const logs = useTuiLogs(logsRef)  // Subscribe to captured logs

  return (
    <>
      <Static items={logs}>
        {log => <Text key={log.id} dim>[{log.level}] {log.message}</Text>}
      </Static>
      {/* ... rest of view */}
    </>
  )
}
```

### Config Integration

```typescript
import { Config, Effect } from 'effect'

const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    const tui = yield* useTuiState(DeployState, { _tag: 'Idle' }, DeployView)

    // Read config (environment variables, etc.)
    const timeout = yield* Config.number('DEPLOY_TIMEOUT').pipe(
      Config.withDefault(30000)
    )
    const cluster = yield* Config.string('DEPLOY_CLUSTER')

    yield* tui.set({ _tag: 'Progress', cluster, ... })
    yield* deployToCluster(cluster, { timeout })
  }).pipe(Effect.scoped)
```

### Scope and Resource Management

The `useTuiState` function is scoped, ensuring cleanup on completion or error:

```typescript
const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    // TUI state is scoped - renderer cleans up automatically
    const tui = yield* useTuiState({
      stateSchema: DeployState,
      actionSchema: DeployAction,
      initial: { _tag: 'Idle' },
      reducer: deployReducer,
      View: DeployView,
    })

    // Additional scoped resources
    const connection = yield* Effect.acquireRelease(acquireConnection(), (conn) =>
      releaseConnection(conn),
    )

    const lock = yield* Effect.acquireRelease(acquireDeployLock(), (lock) => releaseLock(lock))

    // All resources cleaned up when scope closes (success, error, or cancellation)
    yield* runDeployment(connection, lock, tui)
  }).pipe(Effect.scoped)
```

### Metrics and Tracing

```typescript
import { Metric, Effect } from 'effect'

const deployCounter = Metric.counter('deploy.count')
const deployDuration = Metric.histogram('deploy.duration')

const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    yield* Metric.increment(deployCounter)

    const tui = yield* useTuiState({
      stateSchema: DeployState,
      actionSchema: DeployAction,
      initial: { _tag: 'Idle' },
      reducer: deployReducer,
      View: DeployView,
    })

    yield* deployServices(tui, services).pipe(Metric.trackDuration(deployDuration))
  }).pipe(Effect.scoped)
```

---

## Appendix

### Key Decisions

| Decision           | Choice                      | Rationale                                                       |
| ------------------ | --------------------------- | --------------------------------------------------------------- |
| CLI integration    | `@effect/cli`               | Leverage existing CLI framework, don't reinvent command parsing |
| State primitive    | `@effect-atom/atom`         | Better React integration, sync updates, derived state support   |
| State updates      | Reducer-only (Elm)          | Predictable state transitions, centralized logic, testable      |
| Component pattern  | HOC/Adapter                 | Renderer-agnostic code, graceful capability fallbacks           |
| Mode selection     | `OutputMode` service        | Layer-based, testable, composable with Effect patterns          |
| State typing       | Effect Schema               | Type-safe JSON encoding, shareable schemas                      |
| Inline reconciler  | Custom (`react-reconciler`) | Full control, no ink dependency                                 |
| Alternate renderer | OpenTUI                     | Production-ready, full-featured, same Yoga layout               |
| Layout             | Yoga                        | Proven flexbox implementation, shared across renderers          |
| Output diffing     | Line-level (inline)         | Simple, sufficient for CLI scale                                |
| Throttling         | Configurable (default 16ms) | Prevents runaway rendering                                      |

### References

**Design:**

- [Design Exploration (archived)](https://gist.github.com/schickling/98a66ff02e5ab8ade54b418118046c00) - Original working document with detailed design exploration
- [Implementation Plan](../tasks/2026-01-28-effect-cli-integration/plan.md) - Full implementation plan with phases

**Research:**

- [pi-tui](./research/pi-tui.md) - Inline TUI framework with differential rendering
- [OpenTUI](./research/opentui.md) - Full-screen TUI library for alternate mode
- [Yoga Layout](./research/yoga-layout.md) - Flexbox layout engine
- [react-reconciler](./research/react-reconciler.md) - Custom React renderer API

**External:**

- [Effect Atom GitHub](https://github.com/tim-smart/effect-atom) - Reactive state for Effect
- [pi-tui GitHub](https://github.com/badlogic/pi-mono/tree/main/packages/tui)
- [OpenTUI GitHub](https://github.com/anomalyco/opentui)
- [Yoga Documentation](https://yogalayout.dev/)
- [react-reconciler README](https://github.com/facebook/react/tree/main/packages/react-reconciler)
