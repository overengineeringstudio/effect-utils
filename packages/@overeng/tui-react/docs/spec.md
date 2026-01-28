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

## Command Author API

### Overview

Command authors define state schemas, create commands that produce state, and optionally handle input events.

```typescript
import { Command, CommandIO } from '@overeng/tui-react'
import { Schema, Effect, SubscriptionRef } from 'effect'

// 1. Define state schema
const DeployState = Schema.Union(
  Schema.TaggedStruct('Deploy.Idle', {}),
  Schema.TaggedStruct('Deploy.Validating', {}),
  Schema.TaggedStruct('Deploy.Progress', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: Schema.Literal('pending', 'deploying', 'healthy', 'failed'),
    })),
  }),
  Schema.TaggedStruct('Deploy.Complete', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: Schema.Literal('updated', 'unchanged', 'rolled-back'),
    })),
    duration: Schema.Number,
  }),
  Schema.TaggedStruct('Deploy.Failed', {
    service: Schema.String,
    error: Schema.String,
  }),
)
type DeployState = Schema.Schema.Type<typeof DeployState>

// 2. Define command
const deploy = Command.make({
  name: 'deploy',
  stateSchema: DeployState,
  initialState: { _tag: 'Deploy.Idle' } as DeployState,
  run: (io: CommandIO<DeployState>) => Effect.gen(function* () {
    // Update state as work progresses
    yield* SubscriptionRef.set(io.state, { _tag: 'Deploy.Validating' })
    
    // ... do work ...
    
    yield* SubscriptionRef.set(io.state, {
      _tag: 'Deploy.Progress',
      services: [
        { name: 'api-server', status: 'deploying' },
        { name: 'web-client', status: 'pending' },
      ],
    })
    
    // ... continue ...
  }),
})
```

### Command.make

```typescript
interface CommandConfig<State, Action = never> {
  /** Command name (used in help, errors) */
  name: string
  
  /** Effect Schema for state (enables JSON serialization) */
  stateSchema: Schema.Schema<State>
  
  /** Initial state value */
  initialState: State
  
  /** Optional action schema for interactive commands */
  actionSchema?: Schema.Schema<Action>
  
  /** Command implementation */
  run: (io: CommandIO<State, Action>) => Effect.Effect<void, CommandError, R>
}

function make<State, Action, R>(
  config: CommandConfig<State, Action>
): Command<State, Action, R>
```

### CommandIO

The `CommandIO` interface is passed to every command's `run` function:

```typescript
interface CommandIO<State, Action = never> {
  /** Current state (read/write) */
  state: SubscriptionRef.SubscriptionRef<State>
  
  /** Input events from renderer (keyboard, resize) */
  events: Stream.Stream<InputEvent>
  
  /** Dispatch action (for interactive commands) */
  dispatch: (action: Action) => Effect.Effect<void>
  
  /** Output mode (for conditional behavior) */
  mode: OutputMode
  
  /** Abort signal (for cancellation) */
  signal: AbortSignal
}
```

### Running Commands

```typescript
import { Command } from '@overeng/tui-react'

// Run with auto-detected mode
await Command.run(deploy, { services: ['api-server', 'web-client'] })

// Run with explicit mode
await Command.run(deploy, { services: ['api-server'] }, {
  mode: 'final-json',
})

// Run with custom renderer
await Command.runWith(deploy, { services: ['api-server'] }, {
  renderer: myCustomRenderer,
})
```

---

## Complete Example

A full deploy command implementation:

```typescript
// deploy.ts
import { Command, CommandIO, Static, Box, Text, Spinner } from '@overeng/tui-react'
import { Schema, Effect, SubscriptionRef, Stream, Duration } from 'effect'

// ============================================================
// State Schema
// ============================================================

const ServiceStatus = Schema.Literal('pending', 'deploying', 'healthy', 'failed')
const ServiceResult = Schema.Literal('updated', 'unchanged', 'rolled-back')

const Service = Schema.Struct({
  name: Schema.String,
  status: ServiceStatus,
})

const ServiceComplete = Schema.Struct({
  name: Schema.String,
  result: ServiceResult,
  duration: Schema.Number,
})

const LogEntry = Schema.Struct({
  id: Schema.String,
  time: Schema.String,
  message: Schema.String,
})

const DeployState = Schema.Union(
  Schema.TaggedStruct('Deploy.Idle', {}),
  Schema.TaggedStruct('Deploy.Validating', {
    logs: Schema.Array(LogEntry),
  }),
  Schema.TaggedStruct('Deploy.Progress', {
    services: Schema.Array(Service),
    logs: Schema.Array(LogEntry),
  }),
  Schema.TaggedStruct('Deploy.Complete', {
    services: Schema.Array(ServiceComplete),
    logs: Schema.Array(LogEntry),
    totalDuration: Schema.Number,
  }),
  Schema.TaggedStruct('Deploy.Failed', {
    services: Schema.Array(ServiceComplete),
    error: Schema.String,
    logs: Schema.Array(LogEntry),
  }),
)

type DeployState = Schema.Schema.Type<typeof DeployState>
type LogEntry = Schema.Schema.Type<typeof LogEntry>

// ============================================================
// Command Implementation
// ============================================================

interface DeployArgs {
  services: string[]
  environment: string
}

const deployCommand = Command.make({
  name: 'deploy',
  stateSchema: DeployState,
  initialState: { _tag: 'Deploy.Idle' } as DeployState,
  
  run: (io: CommandIO<DeployState>, args: DeployArgs) => Effect.gen(function* () {
    const startTime = Date.now()
    const logs: LogEntry[] = []
    
    const log = (message: string) => {
      logs.push({
        id: crypto.randomUUID(),
        time: new Date().toISOString().slice(11, 19),
        message,
      })
    }
    
    // Phase 1: Validation
    log(`Validating deployment to ${args.environment}`)
    yield* SubscriptionRef.set(io.state, { _tag: 'Deploy.Validating', logs })
    yield* Effect.sleep(Duration.millis(500))
    log('Configuration valid')
    
    // Phase 2: Deploy services
    const services = args.services.map(name => ({ name, status: 'pending' as const }))
    yield* SubscriptionRef.set(io.state, { _tag: 'Deploy.Progress', services, logs })
    
    const results: Array<{ name: string; result: 'updated' | 'unchanged'; duration: number }> = []
    
    for (const service of args.services) {
      // Update to deploying
      log(`Deploying ${service}...`)
      yield* SubscriptionRef.update(io.state, state => {
        if (state._tag !== 'Deploy.Progress') return state
        return {
          ...state,
          logs,
          services: state.services.map(s =>
            s.name === service ? { ...s, status: 'deploying' as const } : s
          ),
        }
      })
      
      // Simulate deploy
      const deployStart = Date.now()
      yield* Effect.sleep(Duration.millis(800 + Math.random() * 400))
      
      // Update to healthy
      log(`${service} is healthy`)
      yield* SubscriptionRef.update(io.state, state => {
        if (state._tag !== 'Deploy.Progress') return state
        return {
          ...state,
          logs,
          services: state.services.map(s =>
            s.name === service ? { ...s, status: 'healthy' as const } : s
          ),
        }
      })
      
      results.push({
        name: service,
        result: 'updated',
        duration: Date.now() - deployStart,
      })
    }
    
    // Phase 3: Complete
    const totalDuration = Date.now() - startTime
    log(`Deploy complete in ${(totalDuration / 1000).toFixed(1)}s`)
    
    yield* SubscriptionRef.set(io.state, {
      _tag: 'Deploy.Complete',
      services: results,
      logs,
      totalDuration,
    })
  }),
})

// ============================================================
// Visual Renderer (React Component)
// ============================================================

function DeployView({ state }: { state: DeployState }) {
  if (state._tag === 'Deploy.Idle') {
    return null
  }
  
  const logs = 'logs' in state ? state.logs : []
  
  return (
    <>
      <Static items={logs}>
        {(log) => (
          <Text key={log.id} dim>
            [{log.time}] {log.message}
          </Text>
        )}
      </Static>
      
      {state._tag === 'Deploy.Validating' && (
        <Box>
          <Spinner /> Validating configuration...
        </Box>
      )}
      
      {state._tag === 'Deploy.Progress' && (
        <Box flexDirection="column">
          <Text>● Deploying {state.services.filter(s => s.status === 'healthy').length}/{state.services.length} services</Text>
          {state.services.map(service => (
            <Box key={service.name} paddingLeft={2}>
              <Text>
                {service.status === 'healthy' && '✓ '}
                {service.status === 'deploying' && <><Spinner /> </>}
                {service.status === 'pending' && '○ '}
                {service.status === 'failed' && '✗ '}
                {service.name}
                {service.status !== 'pending' && ` (${service.status})`}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      
      {state._tag === 'Deploy.Complete' && (
        <Box flexDirection="column">
          <Text color="green">✓ Deploy complete</Text>
          {state.services.map(service => (
            <Box key={service.name} paddingLeft={2}>
              <Text>✓ {service.name} ({service.result}, {(service.duration / 1000).toFixed(1)}s)</Text>
            </Box>
          ))}
          <Text dim>{'\n'}{state.services.length} services deployed in {(state.totalDuration / 1000).toFixed(1)}s</Text>
        </Box>
      )}
      
      {state._tag === 'Deploy.Failed' && (
        <Box flexDirection="column">
          <Text color="red">✗ Deploy failed: {state.error}</Text>
        </Box>
      )}
    </>
  )
}

// ============================================================
// Usage
// ============================================================

// CLI entry point
await Command.run(deployCommand, {
  services: ['api-server', 'web-client', 'worker'],
  environment: 'production',
})
```

**Output in progressive-visual-inline mode:**
```
[14:23:01] Validating deployment to production
[14:23:01] Configuration valid
[14:23:02] Deploying api-server...
[14:23:03] api-server is healthy
[14:23:03] Deploying web-client...
● Deploying 1/3 services
  ✓ api-server (healthy)
  ◐ web-client (deploying)
  ○ worker
```

**Output in final-json mode:**
```json
{
  "_tag": "Deploy.Complete",
  "services": [
    { "name": "api-server", "result": "updated", "duration": 1024 },
    { "name": "web-client", "result": "updated", "duration": 892 },
    { "name": "worker", "result": "updated", "duration": 756 }
  ],
  "totalDuration": 3421
}
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

### Testing Commands

Commands are pure Effect programs, testable without renderers:

```typescript
import { expect, test } from 'vitest'
import { Effect, SubscriptionRef, Stream } from 'effect'

test('deploy command updates state correctly', async () => {
  const states: DeployState[] = []
  
  await Effect.gen(function* () {
    // Create test IO
    const state = yield* SubscriptionRef.make<DeployState>({ _tag: 'Deploy.Idle' })
    
    // Collect state changes
    const fiber = yield* state.changes.pipe(
      Stream.tap(s => Effect.sync(() => states.push(s))),
      Stream.runDrain,
      Effect.fork,
    )
    
    // Run command
    yield* deployCommand.run(
      { state, events: Stream.empty, dispatch: () => Effect.void, mode: 'final-json', signal: new AbortController().signal },
      { services: ['api-server'], environment: 'test' }
    )
    
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.runPromise)
  
  // Assert state transitions
  expect(states.map(s => s._tag)).toEqual([
    'Deploy.Idle',
    'Deploy.Validating',
    'Deploy.Progress',
    'Deploy.Complete',
  ])
})
```

### Testing Renderers

Use a test renderer that captures output:

```typescript
import { TestRenderer } from '@overeng/tui-react/test'

test('deploy view renders progress correctly', () => {
  const renderer = TestRenderer.create()
  
  renderer.render(
    <DeployView state={{
      _tag: 'Deploy.Progress',
      services: [
        { name: 'api-server', status: 'healthy' },
        { name: 'web-client', status: 'deploying' },
      ],
      logs: [],
    }} />
  )
  
  expect(renderer.toText()).toContain('✓ api-server')
  expect(renderer.toText()).toContain('web-client (deploying)')
})
```

### Snapshot Testing

```typescript
import { TestRenderer } from '@overeng/tui-react/test'

test('deploy complete view matches snapshot', () => {
  const renderer = TestRenderer.create({ columns: 80, rows: 24 })
  
  renderer.render(
    <DeployView state={{
      _tag: 'Deploy.Complete',
      services: [
        { name: 'api-server', result: 'updated', duration: 1024 },
        { name: 'web-client', result: 'unchanged', duration: 0 },
      ],
      logs: [],
      totalDuration: 1500,
    }} />
  )
  
  expect(renderer.toText()).toMatchSnapshot()
})
```

### Testing JSON Output

```typescript
test('deploy produces valid JSON output', async () => {
  const output = await Command.runCapture(deployCommand, {
    services: ['api-server'],
    environment: 'test',
  }, { mode: 'final-json' })
  
  // Validates against schema
  const result = Schema.decodeUnknownSync(DeployState)(JSON.parse(output))
  
  expect(result._tag).toBe('Deploy.Complete')
})
```

### Test Utilities

```typescript
import { TestRenderer, TestIO, runTestCommand } from '@overeng/tui-react/test'

// Quick test helper
const { states, output } = await runTestCommand(deployCommand, {
  args: { services: ['api-server'], environment: 'test' },
  mode: 'progressive-visual-inline',
})

// Simulate user input (for interactive commands)
const io = TestIO.create()
io.pressKey('enter')
io.resize(120, 40)
```

---

## Effect Integration

### Layer System

Commands can require services via Effect's Layer system:

```typescript
import { Layer, Context } from 'effect'

// Define service
class DeployService extends Context.Tag('DeployService')<
  DeployService,
  {
    deploy: (service: string) => Effect.Effect<void, DeployError>
    rollback: (service: string) => Effect.Effect<void, RollbackError>
    healthCheck: (service: string) => Effect.Effect<boolean>
  }
>() {}

// Command requires service
const deployCommand = Command.make({
  name: 'deploy',
  stateSchema: DeployState,
  initialState: { _tag: 'Deploy.Idle' },
  
  run: (io, args) => Effect.gen(function* () {
    const deployService = yield* DeployService
    
    for (const service of args.services) {
      yield* deployService.deploy(service)
      yield* deployService.healthCheck(service)
    }
  }),
})

// Provide layer when running
await Command.run(deployCommand, args).pipe(
  Effect.provide(DeployServiceLive),
  Effect.runPromise,
)
```

### Logging Integration

The renderer integrates with Effect's logging:

```typescript
import { Effect, Logger, LogLevel } from 'effect'

run: (io) => Effect.gen(function* () {
  // Logs appear in static region (visual) or as JSON lines (json mode)
  yield* Effect.log('Starting deployment')
  yield* Effect.logDebug('Connecting to cluster')
  
  yield* Effect.logWarning('Service api-server has high memory usage')
  
  // Errors are also captured
  yield* Effect.logError('Failed to connect').pipe(
    Effect.annotateLogs({ service: 'api-server' })
  )
})

// Configure log level
await Command.run(deployCommand, args, {
  logLevel: LogLevel.Debug,
})
```

**Visual mode log output:**
```
[14:23:01] Starting deployment
[14:23:01] [DEBUG] Connecting to cluster
[14:23:02] [WARN] Service api-server has high memory usage
```

**JSON mode log output:**
```json
{"_tag":"Log","level":"Info","message":"Starting deployment","timestamp":"2024-01-15T14:23:01.000Z"}
{"_tag":"Log","level":"Debug","message":"Connecting to cluster","timestamp":"2024-01-15T14:23:01.500Z"}
```

### Config Integration

```typescript
import { Config } from 'effect'

const deployCommand = Command.make({
  // ...
  run: (io, args) => Effect.gen(function* () {
    // Read config (environment variables, etc.)
    const timeout = yield* Config.number('DEPLOY_TIMEOUT').pipe(
      Config.withDefault(30000)
    )
    
    const cluster = yield* Config.string('DEPLOY_CLUSTER')
    
    yield* deployToCluster(cluster, { timeout })
  }),
})
```

### Scope and Resource Management

```typescript
import { Scope, Effect } from 'effect'

run: (io) => Effect.gen(function* () {
  // Scoped resources are cleaned up automatically
  yield* Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* acquireConnection()
      const lock = yield* acquireDeployLock()
      
      // Both cleaned up when scope closes (success, error, or cancellation)
      yield* runDeployment(connection, lock)
    })
  )
})
```

### Metrics and Tracing

```typescript
import { Metric, Effect } from 'effect'

const deployCounter = Metric.counter('deploy.count')
const deployDuration = Metric.histogram('deploy.duration')

run: (io) => Effect.gen(function* () {
  yield* Metric.increment(deployCounter)
  
  yield* deployServices().pipe(
    Metric.trackDuration(deployDuration)
  )
})

// Metrics are available for export (e.g., to Prometheus)
```

---

## Appendix

### Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| State primitive | `SubscriptionRef` | Supports multiple consumers, late subscribers get current value |
| Event primitive | `PubSub` | Decoupled, supports multiple publishers/subscribers |
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
