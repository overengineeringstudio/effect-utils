# CLI Output Architecture

## Problem Statement

A CLI command can run in different output modes depending on context. We want to decouple command state/logic from output rendering to enable code sharing and principled divergence.

---

## Requirements

### R1: State-Driven Output
Commands must model their state explicitly using Effect Schema. The state is the single source of truth for all renderers.

### R2: Type-Safe JSON Output
JSON output must be derived from Effect Schema definitions (using Schema.encode, not JSON.stringify), enabling:
- Type-safe serialization/deserialization
- Schema can be shared with external consumers
- Tagged structs (`_tag` field) for discriminated unions

### R3: Interactivity Support
The architecture must support input handling for interactive modes while gracefully degrading for non-interactive modes.

### R4: Progressive Updates
Modes that support it should receive real-time state updates. Non-progressive modes should receive final state only (or optionally stream updates as NDJSON).

### R5: Component Reuse
A single canonical React-based renderer should be the foundation, with mode-specific refinements where divergence is necessary.

### R6: Testability
The tui-react package must provide a reliable, mode-specific test suite. Consuming packages should focus on business logic without worrying about rendering correctness.

### R7: Multiple Output Consumers
The state management primitive must support multiple concurrent consumers (e.g., render to terminal AND log to file simultaneously).

---

## Output Dimensions

Output behavior varies along several **independent dimensions**. Understanding these dimensions is crucial for designing a flexible architecture.

### Dimension 1: Temporality

How output evolves over time.

| Value | Description | Use Case |
|-------|-------------|----------|
| `progressive` | Updates stream over time | Progress bars, live status |
| `final` | Single output at completion | CI logs, scripts |

### Dimension 2: Format

The structure and encoding of output.

| Value | Description | Use Case |
|-------|-------------|----------|
| `visual` | Human-readable, ANSI colors | Interactive terminal |
| `json` | Structured, machine-readable | Scripting, tooling integration |

### Dimension 3: Screen

How the output relates to terminal screen buffer (only applicable to `visual` format).

| Value | Description | Use Case |
|-------|-------------|----------|
| `inline` | Within scrollback, dynamic height | Short operations, progress |
| `alternate` | Takes over screen, fixed dimensions | Dashboards, interactive apps |

### Dimension 4: Interactivity

Whether and how input is accepted.

| Value | Description | Use Case |
|-------|-------------|----------|
| `interactive` | Accepts keyboard/mouse input | Navigation, selection |
| `passive` | Output only, no input handling | CI, piped output |

### Dimension Compatibility Matrix

Not all combinations are valid:

| Format | Screen | Interactivity | Temporality | Valid? | Mode Name |
|--------|--------|---------------|-------------|--------|-----------|
| visual | inline | passive | progressive | ✅ | `progressive-visual-inline` |
| visual | inline | interactive | progressive | ✅ | `progressive-visual-inline-interactive` |
| visual | alternate | interactive | progressive | ✅ | `progressive-visual-alternate` |
| visual | inline | passive | final | ✅ | `final-visual-inline` |
| json | n/a | passive | final | ✅ | `final-json` |
| json | n/a | passive | progressive | ✅ | `progressive-json` |
| json | n/a | interactive | * | ❌ | (invalid) |

---

## Mode Names

Use full descriptive names containing all dimension information:

| Mode Name | Description |
|-----------|-------------|
| `progressive-visual-inline` | Real-time updates in scrolling terminal |
| `progressive-visual-alternate` | Full-screen interactive application |
| `final-visual-inline` | Single text output at completion |
| `final-json` | Structured JSON at completion |
| `progressive-json` | NDJSON streaming |

---

## Architecture

### Bidirectional Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     Command Logic                           │
│                     (Effect.gen)                            │
└─────────────────────────┬───────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼                               │
┌─────────────────┐             ┌─────────┴─────────┐
│ SubscriptionRef │             │    Event Queue    │
│   <State>       │             │  (input, resize)  │
│                 │             │                   │
│ state.changes ──┼─────┐       │◀── InputEvent     │
└─────────────────┘     │       │◀── ResizeEvent    │
                        │       └───────────────────┘
                        │                 ▲
                        ▼                 │
              ┌─────────────────────────────────────┐
              │           Renderer                  │
              │                                     │
              │  - Subscribes to state.changes      │
              │  - Publishes events (input, resize) │
              │  - Provides viewport via hook       │
              └─────────────────────────────────────┘
```

### Event Flow: Renderer → Command

```typescript
import { Schema, PubSub, Effect } from 'effect'

// Input events from renderer to command
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
type InputEvent = Schema.Schema.Type<typeof InputEvent>

// Command IO: bidirectional communication
interface CommandIO<S, A> {
  // State flows down (command → renderer)
  state: SubscriptionRef.SubscriptionRef<S>
  
  // Events flow up (renderer → command)
  events: PubSub.PubSub<InputEvent>
  
  // Actions for command to dispatch state changes
  dispatch: (action: A) => Effect.Effect<void>
}
```

### Renderer Publishing Events

```typescript
// Renderer captures input and publishes to event queue
const setupInputHandling = (events: PubSub.PubSub<InputEvent>) =>
  Effect.gen(function* () {
    // Keyboard input
    yield* Effect.fork(
      Terminal.readInput.pipe(
        Stream.runForEach(key => PubSub.publish(events, {
          _tag: 'Event.Key',
          key: key.name,
          ctrl: key.ctrl,
          alt: key.alt,
          shift: key.shift,
        }))
      )
    )
    
    // Terminal resize
    yield* Effect.fork(
      Terminal.onResize.pipe(
        Stream.runForEach(size => PubSub.publish(events, {
          _tag: 'Event.Resize',
          rows: size.rows,
          cols: size.cols,
        }))
      )
    )
  })
```

### Command Handling Events

```typescript
// Command can subscribe to events
const runCommand = <S, A>(io: CommandIO<S, A>) =>
  Effect.gen(function* () {
    // Handle events from renderer
    yield* Effect.fork(
      PubSub.subscribe(io.events).pipe(
        Stream.runForEach(event => {
          switch (event._tag) {
            case 'Event.Key':
              if (event.key === 'q') return Effect.interrupt
              if (event.key === 'j') return io.dispatch({ _tag: 'Action.SelectNext' })
              // ...
            case 'Event.Resize':
              return io.dispatch({ _tag: 'Action.Resize', ...event })
          }
        })
      )
    )
    
    // Main command logic
    yield* doWork(io)
  })
```

---

## Viewport Hook

### Terminal Dimensions

The terminal provides row/column information that we expose to React components:

```typescript
interface Viewport {
  rows: number      // Available rows
  cols: number      // Available columns
  mode: 'inline' | 'alternate'
}

// For inline mode, we may reserve lines and expose available space
interface InlineViewport extends Viewport {
  mode: 'inline'
  maxLines: number  // Lines we're allowed to use (may be < rows)
}

// For alternate mode, we have the full screen
interface AlternateViewport extends Viewport {
  mode: 'alternate'
}
```

### React Hook

```typescript
// Hook for components to access viewport
const useViewport = (): Viewport => {
  const [viewport, setViewport] = useState<Viewport>(getInitialViewport())
  
  useEffect(() => {
    const handler = () => setViewport(getCurrentViewport())
    process.stdout.on('resize', handler)
    return () => process.stdout.off('resize', handler)
  }, [])
  
  return viewport
}

// Components adapt to available space
const MemberList = ({ members }: Props) => {
  const { rows, maxLines } = useViewport()
  
  // In inline mode, show limited items
  const visibleCount = Math.min(members.length, maxLines - 2) // reserve for header/footer
  
  return (
    <Box flexDirection="column">
      {members.slice(0, visibleCount).map(m => (
        <MemberRow key={m.name} member={m} />
      ))}
      {members.length > visibleCount && (
        <Text dimColor>... and {members.length - visibleCount} more</Text>
      )}
    </Box>
  )
}
```

### Inline Mode: Available Lines

For inline progressive rendering, we need to track available lines:

```typescript
interface InlineRenderContext {
  // Initial terminal size
  initialRows: number
  initialCols: number
  
  // How many lines we've used (for cursor management)
  usedLines: number
  
  // Maximum lines we're allowed to use
  // Could be: min(terminalRows - 1, configuredMax)
  maxLines: number
  
  // Current cursor position relative to our output region
  cursorLine: number
}

// Calculate available lines for inline mode
const calculateAvailableLines = (config: Config): number => {
  const terminalRows = process.stdout.rows ?? 24
  
  // Leave at least 1 line for prompt, use at most configured max
  const available = terminalRows - 1
  const configuredMax = config.maxInlineLines ?? 20
  
  return Math.min(available, configuredMax)
}
```

---

## Mode Selection: Presets + Overrides

### Configuration Type

```typescript
interface OutputConfig {
  temporality: 'progressive' | 'final'
  format: 'visual' | 'json'
  screen: 'inline' | 'alternate'  // only relevant for visual
  interactive: boolean
}

// Derive mode name from config
const toModeName = (config: OutputConfig): string => {
  if (config.format === 'json') {
    return config.temporality === 'progressive' ? 'progressive-json' : 'final-json'
  }
  return `${config.temporality}-visual-${config.screen}`
}
```

### Presets

```typescript
const presets: Record<string, OutputConfig> = {
  'progressive-visual-inline': {
    temporality: 'progressive',
    format: 'visual',
    screen: 'inline',
    interactive: false,
  },
  'progressive-visual-alternate': {
    temporality: 'progressive',
    format: 'visual',
    screen: 'alternate',
    interactive: true,
  },
  'final-visual-inline': {
    temporality: 'final',
    format: 'visual',
    screen: 'inline',
    interactive: false,
  },
  'final-json': {
    temporality: 'final',
    format: 'json',
    screen: 'inline',
    interactive: false,
  },
  'progressive-json': {
    temporality: 'progressive',
    format: 'json',
    screen: 'inline',
    interactive: false,
  },
}
```

### CLI Flags

```bash
# Use preset by name
mr sync --output=progressive-visual-inline
mr sync --output=final-json

# Dimensional overrides
mr sync --json                   # format=json, temporality=final (default for json)
mr sync --json --stream          # format=json, temporality=progressive
mr sync --alternate              # screen=alternate
mr sync --no-tty                 # temporality=final, interactive=false

# Resolution
mr sync                          # Auto: progressive-visual-inline if TTY, final-visual-inline otherwise
```

### Resolution Logic

```typescript
const resolveOutputConfig = (flags: Flags, env: Environment): OutputConfig => {
  // Start with environment-based default
  let config: OutputConfig = env.isTTY 
    ? presets['progressive-visual-inline']
    : presets['final-visual-inline']
  
  // Apply preset if specified
  if (flags.output && flags.output in presets) {
    config = { ...presets[flags.output] }
  }
  
  // Apply dimensional overrides
  if (flags.json) {
    config.format = 'json'
    config.temporality = config.temporality ?? 'final'
  }
  if (flags.stream) config.temporality = 'progressive'
  if (flags.alternate) config.screen = 'alternate'
  if (flags.noTty) {
    config.temporality = 'final'
    config.interactive = false
  }
  
  // Validate
  if (config.format === 'json' && config.interactive) {
    throw new Error('JSON format cannot be interactive')
  }
  
  return config
}
```

---

## JSON Encoding with Effect Schema

Use Schema.encode instead of JSON.stringify:

```typescript
import { Schema, JSONSchema } from 'effect'

// Define state schema
const SyncState = Schema.Union(
  Schema.TaggedStruct('Sync.Progress', {
    member: Schema.String,
    progress: Schema.Number,
  }),
  Schema.TaggedStruct('Sync.Complete', {
    results: Schema.Array(Schema.Struct({
      member: Schema.String,
      status: Schema.Literal('cloned', 'updated', 'unchanged'),
    })),
    duration: Schema.Number,
  }),
)

// Encoder for JSON output
const encodeState = Schema.encode(SyncState)

// JSON renderer uses schema encoding
const jsonRenderer = <S>(schema: Schema.Schema<S>) => ({
  render: (output: CommandOutput<S>) =>
    output.state.changes.pipe(
      Stream.runLast,
      Effect.flatMap(state => Schema.encode(schema)(state)),
      Effect.flatMap(encoded => Console.log(JSON.stringify(encoded))),
    )
})

// For NDJSON streaming
const jsonStreamRenderer = <S>(schema: Schema.Schema<S>) => ({
  render: (output: CommandOutput<S>) =>
    output.state.changes.pipe(
      Stream.mapEffect(state => Schema.encode(schema)(state)),
      Stream.runForEach(encoded => Console.log(JSON.stringify(encoded))),
    )
})
```

---

## Decisions Summary

| ID | Decision | Choice |
|----|----------|--------|
| D1 | State Separation | Separate public (Schema) and internal (TypeScript) types |
| D2 | Input Events | Reducer pattern with Schema-defined actions |
| D3 | Mode Selection | Presets + dimensional overrides |
| D4 | effectAtom | Future work - start with SubscriptionRef |
| D5 | Streaming JSON | Same schema union, NDJSON format |
| D6 | JSON Encoding | Use Effect Schema.encode, not JSON.stringify |
| D7 | Event Flow | PubSub for renderer→command events |

---

## Principles

### P1: State-First Design
Commands model state explicitly as Effect Schema, not as side effects.

### P2: Renderer Agnostic Commands
Command implementation should not know which renderer will display output.

### P3: Progressive Enhancement
Richer modes extend simpler ones.

### P4: Explicit Mode Selection
Output mode is explicitly configured via flags, with smart defaults based on environment.

### P5: Schema-Driven Data
All state and events defined with Effect Schema. Use Schema.encode for JSON.

### P6: Semantic Over Visual
JSON output represents semantic domain data, not visual structure.

### P7: Modal Consistency
Error handling and output must stay within the selected modality.

### P8: Graceful Degradation
Inline progressive rendering falls back gracefully in unsupported environments.

### P9: Bidirectional Communication
State flows down (command→renderer), events flow up (renderer→command).

---

## Next Steps

1. [x] Define output dimensions
2. [x] Document bidirectional event flow
3. [x] Design viewport hook
4. [x] Design CLI flag structure
5. [ ] Implement OutputConfig types
6. [ ] Implement viewport context and hook
7. [ ] Implement event system (PubSub)
8. [ ] Build inline renderer with safeguards
9. [ ] Add JSON renderer with Schema.encode
10. [ ] Explore alternate screen / OpenTUI
