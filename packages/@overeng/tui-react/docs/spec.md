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

Output behavior varies along four independent dimensions:

| Dimension | Values | Description |
|-----------|--------|-------------|
| **Temporality** | `progressive` / `final` | Updates over time vs single output at completion |
| **Format** | `visual` / `json` | Human-readable (ANSI) vs machine-readable (JSON) |
| **Screen** | `inline` / `alternate` | Within scrollback vs full-screen takeover |
| **Interactivity** | `interactive` / `passive` | Accepts input vs output-only |

### Valid Modes

| Mode Name | Temporality | Format | Screen | Interactive | Use Case |
|-----------|-------------|--------|--------|-------------|----------|
| `progressive-visual-inline` | progressive | visual | inline | no | Progress bars, status updates |
| `progressive-visual-alternate` | progressive | visual | alternate | yes | Dashboards, interactive TUIs |
| `final-visual-inline` | final | visual | inline | no | CI output, simple results |
| `final-json` | final | json | n/a | no | Scripting, tool integration |
| `progressive-json` | progressive | json | n/a | no | Streaming (NDJSON) |

**Invalid combinations:** JSON format cannot be interactive.

---

## Mode Specifications

### `progressive-visual-inline`

Real-time visual updates within terminal scrollback.

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
- Must clean up dynamic region on unmount (cursor restore, clear lines)
- Static content cannot be "unwritten" once rendered

**Degradation:**
- Non-TTY → Falls back to `final-visual-inline`

**Example output:**
```
[deploy] Validating configuration...   ← Static
[deploy] Configuration valid           ← Static
● Deploying 2/4 services               ← Dynamic (updates in place)
  ✓ api-server (healthy)
  ◐ web-client (starting)
```

---

### `progressive-visual-alternate`

Full-screen interactive application using alternate screen buffer. **Implemented via [OpenTUI](https://github.com/anomalyco/opentui)**.

> See [OpenTUI Research](./research/opentui.md) for integration details.

**Use cases:** Dashboards, file browsers, interactive selection

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

**Constraints:**
- Requires TTY (cannot work in pipes)
- Must restore original screen on exit (normal or error)
- No scrollback (alternate buffer is isolated)
- Single viewport, no static/dynamic split
- Different component set than inline mode (OpenTUI components)

**Degradation:**
- Non-TTY → Falls back to `final-visual-inline`
- Non-interactive flag → Falls back to `progressive-visual-inline`

**Cleanup requirements (handled by OpenTUI):**
- Exit alternate screen buffer
- Restore cursor visibility
- Restore terminal modes (raw mode off)

---

### `final-visual-inline`

Single visual output rendered at command completion.

**Use cases:** CI pipelines, simple command results, non-TTY environments

**Requirements:**
- Wait for command completion (final state)
- Render final state once to stdout
- No cursor manipulation or screen clearing
- Plain output with optional ANSI colors (respect `NO_COLOR` env)

**Constraints:**
- No progress updates during execution
- No input handling
- No dynamic re-rendering
- Output is append-only (like normal stdout)

**Degradation:**
- This is the baseline mode; no further degradation

**Example output:**
```
Deploy complete:
  ✓ api-server (updated, 1.2s)
  ✓ web-client (unchanged)
  ✓ worker (updated, 0.8s)

3 services deployed in 3.4s
```

---

### `final-json`

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

### `progressive-json`

Streaming JSON output (NDJSON format) as state changes.

**Use cases:** Real-time monitoring, log aggregation, streaming to other tools

**Requirements:**
- Output one JSON object per line as state changes
- Each line is valid JSON (NDJSON format)
- Use `Schema.encode` for each state emission
- Flush after each line for real-time streaming

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

```
┌─────────────────────────────────────────────────────────────────┐
│                        Command Logic                             │
│                        (Effect.gen)                              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                │                               │
                ▼                               ▼
      ┌─────────────────┐             ┌─────────────────┐
      │ SubscriptionRef │             │     PubSub      │
      │    <State>      │             │  <InputEvent>   │
      │                 │             │                 │
      │  state.changes ─┼──────┐      │◀── KeyEvent     │
      └─────────────────┘      │      │◀── ResizeEvent  │
                               │      └─────────────────┘
                               │               ▲
                               ▼               │
                    ┌──────────────────────────┴──────┐
                    │            Renderer             │
                    │                                 │
                    │  - Subscribes to state.changes  │
                    │  - Publishes input events       │
                    │  - Provides viewport context    │
                    └─────────────────────────────────┘
```

### State (Command → Renderer)

Commands expose state via `SubscriptionRef`:

```typescript
import { SubscriptionRef, Schema } from 'effect'

// Deployment state schema (tagged union)
const DeployState = Schema.Union(
  Schema.TaggedStruct('Deploy.Idle', {}),
  Schema.TaggedStruct('Deploy.Validating', {}),
  Schema.TaggedStruct('Deploy.Progress', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: Schema.Literal('pending', 'pulling', 'starting', 'healthy', 'failed'),
    })),
  }),
  Schema.TaggedStruct('Deploy.Complete', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      result: Schema.Literal('updated', 'unchanged', 'rolled-back'),
      duration: Schema.Number,
    })),
    totalDuration: Schema.Number,
  }),
)

// Command exposes state
interface CommandOutput<S> {
  state: SubscriptionRef.SubscriptionRef<S>
}
```

Renderers subscribe to `state.changes` (a `Stream`) to receive updates.

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

### CommandIO Interface

```typescript
interface CommandIO<State, Action> {
  /** State stream (command → renderer) */
  state: SubscriptionRef.SubscriptionRef<State>
  
  /** Event queue (renderer → command) */
  events: PubSub.PubSub<InputEvent>
  
  /** Dispatch action to update state */
  dispatch: (action: Action) => Effect.Effect<void>
}
```

---

## Mode Selection

### Configuration

```typescript
interface OutputConfig {
  temporality: 'progressive' | 'final'
  format: 'visual' | 'json'
  screen: 'inline' | 'alternate'
  interactive: boolean
}
```

### Resolution

1. **Environment default:** TTY → `progressive-visual-inline`, non-TTY → `final-visual-inline`
2. **Preset override:** `--output=<mode-name>` selects a preset
3. **Dimensional override:** `--json`, `--stream`, `--alternate` modify individual dimensions

```bash
# Auto-detect from environment
deploy                                 # TTY → progressive-visual-inline
deploy                                 # Pipe → final-visual-inline

# Explicit mode selection
deploy --output=final-json             # Explicit preset
deploy --json                          # Shorthand for final-json
deploy --json --stream                 # progressive-json (NDJSON)

# Interactive dashboard
deploy --alternate                     # progressive-visual-alternate (full-screen)
deploy --watch --alternate             # Long-running with dashboard

# Scripting integration
deploy --json | jq '.services[]'       # Parse with jq
deploy --json --stream | process-logs  # Stream processing
```

### Validation

- JSON + interactive → Error
- Alternate + non-TTY → Falls back to inline
- Progressive + non-TTY → Falls back to final

---

## Rendering

### Inline Renderer (tui-react)

For `progressive-visual-inline` and `final-visual-inline` modes.

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

For `progressive-visual-alternate` mode.

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
  /** Min ms between renders. Default: 16 (~60fps) */
  throttleMs?: number
  
  /** Max lines for dynamic region. Default: 100 */
  maxDynamicLines?: number
  
  /** Max static lines to buffer. Default: Infinity */
  maxStaticLines?: number
}

const root = createRoot(process.stdout, options)
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
  Effect.flatMap(json => Console.log(JSON.stringify(json))),
)

// Progressive JSON: NDJSON stream
state.changes.pipe(
  Stream.mapEffect(Schema.encode(StateSchema)),
  Stream.runForEach(json => Console.log(JSON.stringify(json))),
)
```

---

## Components

### Core Elements

| Component | Purpose |
|-----------|---------|
| `<Box>` | Flexbox container |
| `<Text>` | Styled text (color, bold, dim, etc.) |
| `<Static>` | Content that persists above dynamic region |
| `<Spinner>` | Animated progress indicator |

### Static Region

Content in `<Static>` is rendered once and persists in terminal scrollback:

```tsx
<>
  <Static items={logs}>
    {(log) => <Text key={log.id} dim>[{log.time}] {log.message}</Text>}
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

### Core Pattern

```typescript
import * as Cli from '@effect/cli'
import { useTuiState, OutputMode } from '@overeng/tui-react'
import { Schema, Effect, Layer } from 'effect'

// 1. Define state schema (shared between visual and JSON modes)
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

// 2. Define React view component
function DeployView({ stateRef }) {
  const state = useSubscriptionRef(stateRef)
  // ... render based on state
}

// 3. Use standard Effect CLI command with TUI state
const deployCommand = Cli.Command.make(
  'deploy',
  { json: jsonOption, stream: streamOption, services: servicesOption },
  ({ json, stream, services }) =>
    Effect.gen(function* () {
      // Get TUI state - mode determines rendering behavior
      const tui = yield* useTuiState(DeployState, { _tag: 'Idle' }, DeployView)
      
      // Update state as work progresses
      yield* tui.set({ _tag: 'Progress', services: [...] })
      
      // ... do work ...
      
      yield* tui.set({ _tag: 'Complete', services: results, totalDuration })
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.succeed(OutputMode, OutputMode.fromFlags(json, stream)))
    )
)
```

### useTuiState

The `useTuiState` function creates scoped state that renders differently based on output mode:

```typescript
const useTuiState: <S>(
  schema: Schema.Schema<S>,
  initial: S,
  View?: React.FC<{ stateRef: SubscriptionRef.SubscriptionRef<S> }>,
) => Effect.Effect<TuiStateApi<S>, never, Scope.Scope | OutputMode>
```

**Returns:**
```typescript
interface TuiStateApi<S> {
  /** Current state ref (for React components) */
  readonly ref: SubscriptionRef.SubscriptionRef<S>
  /** Set state */
  readonly set: (s: S) => Effect.Effect<void>
  /** Update state */
  readonly update: (f: (s: S) => S) => Effect.Effect<void>
  /** Get current state */
  readonly get: Effect.Effect<S>
}
```

**Mode behavior:**
- `progressive-visual`: Renders React component, updates on state change
- `final-json`: Outputs final state as JSON when scope closes
- `progressive-json`: Streams each state change as NDJSON
- `final-visual`: No progressive rendering (for non-TTY)

### OutputMode Service

```typescript
type OutputMode = 
  | { readonly _tag: 'progressive-visual' }
  | { readonly _tag: 'final-visual' }
  | { readonly _tag: 'final-json' }
  | { readonly _tag: 'progressive-json' }

class OutputMode extends Context.Tag('OutputMode')<OutputMode, OutputMode>() {
  /** Create mode from CLI flags */
  static fromFlags(json: boolean, stream: boolean): OutputMode
  
  /** Detect mode from environment (TTY detection) */
  static detect(): OutputMode
}
```

### Standard CLI Options

```typescript
import * as Cli from '@effect/cli'

// Standard --json flag
const jsonOption = Cli.Options.boolean('json').pipe(
  Cli.Options.withAlias('j'),
  Cli.Options.withDescription('Output as JSON'),
  Cli.Options.withDefault(false),
)

// Standard --stream flag for NDJSON
const streamOption = Cli.Options.boolean('stream').pipe(
  Cli.Options.withDescription('Stream JSON output (NDJSON)'),
  Cli.Options.withDefault(false),
)
```

---

## Complete Example

A full deploy command using Effect CLI with tui-react:

```typescript
// deploy.ts
import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Schema, Duration } from 'effect'
import { useTuiState, OutputMode, Box, Text, Spinner, Static, useSubscriptionRef } from '@overeng/tui-react'

// ============================================================
// State Schema (shared between visual and JSON modes)
// ============================================================

const DeployState = Schema.Union(
  Schema.TaggedStruct('Idle', {}),
  Schema.TaggedStruct('Validating', {
    logs: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('Progress', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: Schema.Literal('pending', 'deploying', 'healthy'),
    })),
    logs: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct('Complete', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      result: Schema.Literal('updated', 'unchanged'),
      duration: Schema.Number,
    })),
    logs: Schema.Array(Schema.String),
    totalDuration: Schema.Number,
  }),
)

type DeployState = Schema.Schema.Type<typeof DeployState>

// ============================================================
// React View Component
// ============================================================

function DeployView({ stateRef }: { stateRef: SubscriptionRef.SubscriptionRef<DeployState> }) {
  const state = useSubscriptionRef(stateRef)
  
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
    // Get TUI state - rendering behavior determined by OutputMode
    const tui = yield* useTuiState(DeployState, { _tag: 'Idle' }, DeployView)
    
    const startTime = Date.now()
    const logs: string[] = []
    const log = (msg: string) => { logs.push(msg) }
    
    // Phase 1: Validation
    log('Validating configuration...')
    yield* tui.set({ _tag: 'Validating', logs: [...logs] })
    yield* Effect.sleep(Duration.millis(500))
    log('Configuration valid')
    
    // Phase 2: Deploy services
    const serviceStates = services.map(name => ({ name, status: 'pending' as const }))
    yield* tui.set({ _tag: 'Progress', services: serviceStates, logs: [...logs] })
    
    const results: Array<{ name: string; result: 'updated'; duration: number }> = []
    
    for (let i = 0; i < services.length; i++) {
      const service = services[i]!
      
      log(`Deploying ${service}...`)
      yield* tui.update(s => {
        if (s._tag !== 'Progress') return s
        return {
          ...s,
          logs: [...logs],
          services: s.services.map((svc, idx) =>
            idx === i ? { ...svc, status: 'deploying' as const } : svc
          ),
        }
      })
      
      const deployStart = Date.now()
      yield* Effect.sleep(Duration.millis(600 + Math.random() * 400))
      
      log(`${service} is healthy`)
      yield* tui.update(s => {
        if (s._tag !== 'Progress') return s
        return {
          ...s,
          logs: [...logs],
          services: s.services.map((svc, idx) =>
            idx === i ? { ...svc, status: 'healthy' as const } : svc
          ),
        }
      })
      
      results.push({ name: service, result: 'updated', duration: Date.now() - deployStart })
    }
    
    // Phase 3: Complete
    const totalDuration = Date.now() - startTime
    log(`Deploy complete in ${(totalDuration / 1000).toFixed(1)}s`)
    
    yield* tui.set({
      _tag: 'Complete',
      services: results,
      logs: [...logs],
      totalDuration,
    })
    
    return { services: results, totalDuration }
  }).pipe(Effect.scoped)

// ============================================================
// CLI Definition (standard @effect/cli)
// ============================================================

const jsonOption = Cli.Options.boolean('json').pipe(
  Cli.Options.withAlias('j'),
  Cli.Options.withDefault(false),
)

const streamOption = Cli.Options.boolean('stream').pipe(
  Cli.Options.withDefault(false),
)

const servicesOption = Cli.Options.text('services').pipe(
  Cli.Options.withAlias('s'),
)

const deployCommand = Cli.Command.make(
  'deploy',
  { json: jsonOption, stream: streamOption, services: servicesOption },
  ({ json, stream, services }) =>
    Effect.gen(function* () {
      const serviceList = services.split(',').map(s => s.trim()).filter(Boolean)
      
      // Provide output mode based on flags
      const mode = OutputMode.fromFlags(json, stream)
      
      yield* runDeploy(serviceList).pipe(
        Effect.provide(Layer.succeed(OutputMode, mode))
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
# Progressive visual (default)
mycli deploy --services api,web,worker

# Final JSON
mycli deploy --services api,web --json

# Streaming JSON (NDJSON)
mycli deploy --services api,web --json --stream
```

**Output in progressive-visual mode:**
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

**Output in final-json mode:**
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

**Output in progressive-json mode (NDJSON):**
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

| Mode | Error Handling |
|------|----------------|
| `progressive-visual-inline` | Clear dynamic region, print error, exit |
| `progressive-visual-alternate` | Exit alternate screen, print error to main screen |
| `final-visual-inline` | Print formatted error |
| `final-json` | Output JSON error object |
| `progressive-json` | Output JSON error line, then close stream |

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
  })
)

// Manual recovery in command
run: (io) => Effect.gen(function* () {
  const result = yield* deployService('api-server').pipe(
    Effect.catchTag('HealthCheckFailed', (error) =>
      Effect.gen(function* () {
        yield* log('Health check failed, attempting rollback...')
        yield* rollback('api-server')
        return { status: 'rolled-back' }
      })
    )
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
run: (io) => Effect.gen(function* () {
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
run: (io) => Effect.gen(function* () {
  // Acquire resources
  const connection = yield* DatabaseConnection.acquire()
  
  // Register cleanup
  yield* Effect.addFinalizer(() =>
    DatabaseConnection.release(connection).pipe(
      Effect.catchAll(() => Effect.void) // Don't fail cleanup
    )
  )
  
  // Use resources
  yield* runMigrations(connection)
})
```

### Terminal State Restoration

Renderers guarantee terminal restoration:

| Renderer | Cleanup Actions |
|----------|-----------------|
| Inline | Restore cursor, clear dynamic region, reset styles |
| Alternate | Exit alternate buffer, restore cursor, reset modes |
| JSON | Flush buffer, ensure trailing newline |

---

## Testing

### Testing Command Logic

Command logic is a pure Effect program, testable by providing a test OutputMode:

```typescript
import { expect, test } from 'vitest'
import { Effect, Layer, SubscriptionRef, Stream, Fiber } from 'effect'
import { OutputMode } from '@overeng/tui-react'

test('deploy command updates state correctly', async () => {
  const states: DeployState[] = []
  
  await Effect.gen(function* () {
    // Create state ref to track changes
    const stateRef = yield* SubscriptionRef.make<DeployState>({ _tag: 'Idle' })
    
    // Collect state changes in background
    const fiber = yield* stateRef.changes.pipe(
      Stream.tap(s => Effect.sync(() => states.push(s))),
      Stream.runDrain,
      Effect.fork,
    )
    
    // Run command with test mode (no rendering)
    yield* runDeploy(['api-server', 'web-client']).pipe(
      Effect.provide(Layer.succeed(OutputMode, { _tag: 'final-json' })),
    )
    
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.runPromise)
  
  // Assert state transitions
  expect(states.map(s => s._tag)).toEqual([
    'Idle',
    'Validating',
    'Progress',
    'Progress', // deploying api
    'Progress', // api healthy
    'Progress', // deploying web
    'Progress', // web healthy
    'Complete',
  ])
})
```

### Testing React Components

Use a test renderer that captures output:

```typescript
import { TestRenderer } from '@overeng/tui-react/test'
import { SubscriptionRef } from 'effect'

test('deploy view renders progress correctly', async () => {
  const renderer = TestRenderer.create()
  const stateRef = await Effect.runPromise(
    SubscriptionRef.make<DeployState>({
      _tag: 'Progress',
      services: [
        { name: 'api-server', status: 'healthy' },
        { name: 'web-client', status: 'deploying' },
      ],
      logs: [],
    })
  )
  
  renderer.render(<DeployView stateRef={stateRef} />)
  
  expect(renderer.toText()).toContain('✓ api-server')
  expect(renderer.toText()).toContain('web-client (deploying)')
})
```

### Snapshot Testing

```typescript
import { TestRenderer } from '@overeng/tui-react/test'

test('deploy complete view matches snapshot', async () => {
  const renderer = TestRenderer.create({ columns: 80, rows: 24 })
  const stateRef = await Effect.runPromise(
    SubscriptionRef.make<DeployState>({
      _tag: 'Complete',
      services: [
        { name: 'api-server', result: 'updated', duration: 1024 },
        { name: 'web-client', result: 'unchanged', duration: 0 },
      ],
      logs: [],
      totalDuration: 1500,
    })
  )
  
  renderer.render(<DeployView stateRef={stateRef} />)
  
  expect(renderer.toText()).toMatchSnapshot()
})
```

### Testing JSON Output

```typescript
import { Effect, Layer, SubscriptionRef, Stream } from 'effect'
import { OutputMode } from '@overeng/tui-react'

test('deploy produces valid JSON output', async () => {
  const outputs: string[] = []
  
  // Capture console.log output
  const originalLog = console.log
  console.log = (msg: string) => outputs.push(msg)
  
  try {
    await runDeploy(['api-server']).pipe(
      Effect.provide(Layer.succeed(OutputMode, { _tag: 'final-json' })),
      Effect.runPromise,
    )
  } finally {
    console.log = originalLog
  }
  
  // Validate JSON output against schema
  const result = Schema.decodeUnknownSync(DeployState)(JSON.parse(outputs[0]!))
  expect(result._tag).toBe('Complete')
})
```

### Test Utilities

```typescript
import { TestRenderer, mockOutputMode } from '@overeng/tui-react/test'

// Quick test helper for running commands with captured output
const { states, jsonOutput } = await runTestCommand(runDeploy, {
  args: ['api-server', 'web-client'],
  mode: 'final-json',
})

expect(states).toHaveLength(8)
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
import { useTuiState, OutputMode } from '@overeng/tui-react'

// Define service
class DeployService extends Context.Tag('DeployService')<
  DeployService,
  {
    deploy: (service: string) => Effect.Effect<void, DeployError>
    rollback: (service: string) => Effect.Effect<void, RollbackError>
    healthCheck: (service: string) => Effect.Effect<boolean>
  }
>() {}

// Command uses service alongside TUI state
const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    const tui = yield* useTuiState(DeployState, { _tag: 'Idle' }, DeployView)
    const deployService = yield* DeployService
    
    for (const service of services) {
      yield* tui.update(s => ({ ...s, current: service }))
      yield* deployService.deploy(service)
      yield* deployService.healthCheck(service)
    }
  }).pipe(Effect.scoped)

// Provide layers when running
const deployCommand = Cli.Command.make('deploy', { services: servicesOption }, ({ services }) =>
  runDeploy(services.split(',')).pipe(
    Effect.provide(Layer.succeed(OutputMode, { _tag: 'progressive-visual' })),
    Effect.provide(DeployServiceLive),
  )
)
```

### Logging Integration

Effect logs can be captured and displayed in the TUI:

```typescript
import { Effect, Logger } from 'effect'

const runDeploy = (services: string[]) =>
  Effect.gen(function* () {
    const tui = yield* useTuiState(DeployState, { _tag: 'Idle' }, DeployView)
    
    // Standard Effect logging
    yield* Effect.log('Starting deployment')
    yield* Effect.logDebug('Connecting to cluster')
    yield* Effect.logWarning('High memory usage detected')
    
    // Update TUI state separately
    yield* tui.set({ _tag: 'Progress', ... })
  }).pipe(Effect.scoped)

// Custom logger that feeds into TUI static region (future enhancement)
const TuiLogger = Logger.make(({ message }) => {
  // Append to static region
})
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
    const tui = yield* useTuiState(DeployState, { _tag: 'Idle' }, DeployView)
    
    // Additional scoped resources
    const connection = yield* Effect.acquireRelease(
      acquireConnection(),
      (conn) => releaseConnection(conn)
    )
    
    const lock = yield* Effect.acquireRelease(
      acquireDeployLock(),
      (lock) => releaseLock(lock)
    )
    
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
    
    const tui = yield* useTuiState(DeployState, { _tag: 'Idle' }, DeployView)
    
    yield* deployServices(tui).pipe(
      Metric.trackDuration(deployDuration)
    )
  }).pipe(Effect.scoped)
```

---

## Appendix

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| CLI integration | `@effect/cli` | Leverage existing CLI framework, don't reinvent command parsing |
| State primitive | `SubscriptionRef` | Supports multiple consumers, late subscribers get current value |
| Mode selection | `OutputMode` service | Layer-based, testable, composable with Effect patterns |
| State typing | Effect Schema | Type-safe JSON encoding, shareable schemas |
| Inline reconciler | Custom (`react-reconciler`) | Full control, no ink dependency |
| Alternate renderer | OpenTUI | Production-ready, full-featured, same Yoga layout |
| Layout | Yoga | Proven flexbox implementation, shared across renderers |
| Output diffing | Line-level (inline) | Simple, sufficient for CLI scale |
| Throttling | Configurable (default 16ms) | Prevents runaway rendering |

### References

**Design:**
- [Design Exploration (archived)](https://gist.github.com/schickling/98a66ff02e5ab8ade54b418118046c00) - Original working document with detailed design exploration

**Research:**
- [pi-tui](./research/pi-tui.md) - Inline TUI framework with differential rendering
- [OpenTUI](./research/opentui.md) - Full-screen TUI library for alternate mode
- [Yoga Layout](./research/yoga-layout.md) - Flexbox layout engine
- [react-reconciler](./research/react-reconciler.md) - Custom React renderer API

**External:**
- [pi-tui GitHub](https://github.com/badlogic/pi-mono/tree/main/packages/tui)
- [OpenTUI GitHub](https://github.com/anomalyco/opentui)
- [Yoga Documentation](https://yogalayout.dev/)
- [react-reconciler README](https://github.com/facebook/react/tree/main/packages/react-reconciler)
