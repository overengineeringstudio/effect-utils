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

**Example output (file sync):**
```
[INFO] Connecting to server...     ← Static
[INFO] Authenticated as user@host  ← Static
● Syncing 3/5 files                ← Dynamic (updates in place)
  ✓ config.json
  ✓ schema.sql  
  ◐ data.csv
```

**Example output (build system):**
```
[tsc] Compiling TypeScript...      ← Static
[tsc] Found 0 errors               ← Static
● Building 2/4 packages            ← Dynamic (updates in place)
  ✓ @app/core
  ◐ @app/server
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

**Example output (deployment):**
```
Deploy complete:
  ✓ api-server (updated)
  ✓ web-client (unchanged)
  ✓ worker (scaled to 3)

3 services deployed in 45.2s
```

**Example output (migration):**
```
Migration complete:
  ✓ 001_create_users (applied)
  ✓ 002_add_email_index (applied)
  ⊘ 003_add_roles (skipped - already applied)

2 migrations applied in 1.3s
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

**Success format (deployment):**
```json
{
  "_tag": "Deploy.Complete",
  "services": [
    { "name": "api-server", "status": "updated", "replicas": 2 },
    { "name": "web-client", "status": "unchanged", "replicas": 1 }
  ],
  "duration": 45.2
}
```

**Success format (build):**
```json
{
  "_tag": "Build.Complete",
  "packages": [
    { "name": "@app/core", "status": "built", "duration": 1.2 },
    { "name": "@app/server", "status": "cached" }
  ],
  "totalDuration": 3.4
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

**Stream format (test runner):**
```
{"_tag":"Test.Started","suite":"auth","test":"login"}
{"_tag":"Test.Passed","suite":"auth","test":"login","duration":45}
{"_tag":"Test.Started","suite":"auth","test":"logout"}
{"_tag":"Test.Failed","suite":"auth","test":"logout","error":"Timeout"}
{"_tag":"Test.Complete","passed":1,"failed":1,"duration":892}
```

**Stream format (file watcher):**
```
{"_tag":"Watch.Changed","path":"src/index.ts","event":"modify"}
{"_tag":"Build.Started"}
{"_tag":"Build.Complete","duration":1.2}
{"_tag":"Watch.Changed","path":"src/utils.ts","event":"modify"}
```

**Error in stream:**
```
{"_tag":"Deploy.Progress","service":"api-server","phase":"pulling"}
{"_tag":"Error","code":"IMAGE_NOT_FOUND","message":"Image not found in registry"}
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

// Example: Build system state schema (tagged union)
const BuildState = Schema.Union(
  Schema.TaggedStruct('Build.Idle', {}),
  Schema.TaggedStruct('Build.Progress', {
    package: Schema.String,
    current: Schema.Number,
    total: Schema.Number,
  }),
  Schema.TaggedStruct('Build.Complete', {
    packages: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: Schema.Literal('built', 'cached', 'failed'),
      duration: Schema.optional(Schema.Number),
    })),
    totalDuration: Schema.Number,
  }),
)

// Example: Deployment state schema
const DeployState = Schema.Union(
  Schema.TaggedStruct('Deploy.Idle', {}),
  Schema.TaggedStruct('Deploy.Progress', {
    service: Schema.String,
    phase: Schema.Literal('pulling', 'starting', 'healthcheck'),
  }),
  Schema.TaggedStruct('Deploy.Complete', {
    services: Schema.Array(Schema.Struct({
      name: Schema.String,
      status: Schema.Literal('updated', 'unchanged', 'rolled-back'),
    })),
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
# Generic CLI patterns
mycli deploy                          # Auto-detect from environment
mycli deploy --output=final-json      # Explicit preset
mycli deploy --json                   # Shorthand for final-json
mycli deploy --json --stream          # progressive-json (NDJSON)

# Example: build tool
build --watch                         # progressive-visual-inline
build --watch --alternate             # progressive-visual-alternate (dashboard)
build --json | jq '.packages[]'       # final-json for scripting

# Example: test runner
test --json --stream | tap-parser     # progressive-json for TAP consumers
test --output=final-visual-inline     # CI-friendly output
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

Output (build tool):
```
[10:01:23] Compiling @app/core...   ← Static (persists)
[10:01:24] Built @app/core (1.2s)   ← Static (persists)
● Building @app/server...           ← Dynamic (updates in place)
```

Output (test runner):
```
✓ auth/login (45ms)                 ← Static (persists)
✓ auth/logout (32ms)                ← Static (persists)
● Running users/create...           ← Dynamic (updates in place)
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
