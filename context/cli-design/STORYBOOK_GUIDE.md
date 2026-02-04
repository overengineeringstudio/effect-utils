# CLI Storybook Best Practices

Guidelines for creating Storybook stories for CLI output components.

## Assumptions

- A1 - Stories use `@overeng/tui-react` and `TuiStoryPreview` component for rendering
- A2 - CLI views follow the app/schema/view pattern with Effect Schema for state
- A3 - Output supports multiple modes (TTY, CI, JSON, etc.) via the tui-react output system

## Requirements

- R1 - **Semantic equivalence**: Interactive and static modes must end at identical state. Timeline must produce same final state as static rendering.
- R2 - **Realistic scenarios**: Story data, timing, and error cases must reflect real CLI usage. Use representative file paths, realistic counts, plausible error messages.
- R3 - **Flag coverage**: Every meaningful CLI flag gets a Storybook control. Users explore all variations without touching code.
- R4 - **Output format coverage**: All stories test all output modes (TTY, CI, JSON, etc.) via ALL_TABS.

## Core Principle

**Every meaningful CLI flag gets a Storybook control.** Users should be able to explore all output variations without touching code.

## Directory Structure

```
CommandOutput/
  stories/
    _fixtures.ts       # State factories, example data, timeline
    Success.stories.tsx
    Errors.stories.tsx
  mod.ts
  schema.ts
  view.tsx
```

## Standard Controls

Every story includes these base controls:

```typescript
type StoryArgs = {
  height: number // Terminal viewport height
  interactive: boolean // Toggle animated vs static
  playbackSpeed: number // Timeline speed (conditional on interactive)
  // + all CLI flags as controls
}
```

### Control Configuration

```typescript
argTypes: {
  height: {
    control: { type: 'range', min: 200, max: 600, step: 50 },
  },
  interactive: {
    description: 'Enable animated timeline playback',
    control: { type: 'boolean' },
  },
  playbackSpeed: {
    control: { type: 'range', min: 0.5, max: 3, step: 0.5 },
    if: { arg: 'interactive' },  // Only show when interactive
  },
  dryRun: { control: 'boolean' },  // --dry-run
  force: { control: 'boolean' },   // --force
  all: { control: 'boolean' },     // --all
  mode: {                          // enum flags
    control: 'select',
    options: ['generate', 'check', 'dry-run'],
  },
}
```

## State Factories (`_fixtures.ts`)

```typescript
// Base factory with defaults
export const createState = (overrides?: Partial<State>): State => ({
  phase: 'complete',
  options: { dryRun: false, force: false },
  results: [],
  ...overrides,
})

// Named scenario factories
export const createWithErrorsState = (opts: { mode: Mode }): State =>
  createState({
    mode: opts.mode,
    results: [
      { name: 'file1', status: 'error', message: 'Failed' },
      { name: 'file2', status: 'success' },
    ],
  })
```

## Timeline Factory

Enables animated state progression when `interactive=true`:

```typescript
export const createTimeline = (config: {
  results: Result[]
  options: Options
}): Array<{ at: number; action: Action }> => {
  const timeline: Array<{ at: number; action: Action }> = []
  const stepDuration = 600

  // Start state
  timeline.push({
    at: 0,
    action: { _tag: 'SetState', state: createState({ phase: 'running' }) },
  })

  // Progressive results
  for (let i = 0; i < config.results.length; i++) {
    timeline.push({
      at: (i + 1) * stepDuration,
      action: {
        _tag: 'SetState',
        state: createState({
          phase: i === config.results.length - 1 ? 'complete' : 'running',
          results: config.results.slice(0, i + 1),
        }),
      },
    })
  }

  return timeline
}
```

## Story Pattern

```typescript
export const MixedResults: Story = {
  render: (args) => {
    // Memoize config for arg reactivity
    const stateConfig = useMemo(
      () => ({
        options: { dryRun: args.dryRun, force: args.force },
        results: exampleResults,
      }),
      [args.dryRun, args.force],
    )

    return (
      <TuiStoryPreview
        View={MyView}
        app={MyApp}
        initialState={
          args.interactive
            ? createState({ phase: 'idle' })
            : createState(stateConfig)
        }
        height={args.height}
        autoRun={args.interactive}
        playbackSpeed={args.playbackSpeed}
        tabs={ALL_TABS}
        {...(args.interactive ? { timeline: createTimeline(stateConfig) } : {})}
      />
    )
  },
}
```

## Output Tabs

```typescript
const ALL_TABS: OutputTab[] = [
  'tty', // Interactive terminal
  'alt-screen', // Full-screen TUI
  'ci', // CI mode with colors
  'ci-plain', // CI mode without colors
  'pipe', // Piped output
  'log', // Structured log format
  'json', // JSON output
  'ndjson', // Newline-delimited JSON
]
```

## Story Organization

Group by scenario type:

| File                   | Purpose                          |
| ---------------------- | -------------------------------- |
| `Success.stories.tsx`  | Success scenarios, mixed results |
| `Errors.stories.tsx`   | Error handling, failures         |
| `Overflow.stories.tsx` | Viewport truncation, many items  |

## Anti-Patterns

- **Hardcoded state** - Use controls and state factories, not inline `initialState={{ ... }}`
- **Divergent interactive/static paths** - Both modes must use same `stateConfig`, only starting point differs
- **Separate "Demo" stories** - Every story should have `interactive` toggle, not separate animated stories
- **Subset of output tabs** - Always use `ALL_TABS`, not `tabs={['tty']}`
- **Fake/placeholder data** - Use realistic paths (`packages/foo/...`), not `test1`, `example.txt`

## Checklist

**R1 - Semantic equivalence:**

- [ ] Timeline and static mode use same `stateConfig`
- [ ] Timeline ends at same final state as static rendering
- [ ] `interactive` toggle switches mode without changing outcome

**R2 - Realistic scenarios:**

- [ ] File paths look real (e.g., `packages/foo/package.json`)
- [ ] Error messages are plausible (e.g., `SyntaxError`, `ENOENT`)
- [ ] Counts and timing reflect typical usage

**R3 - Flag coverage:**

- [ ] Every CLI flag has a corresponding control
- [ ] `useMemo` wraps config dependent on flag args
- [ ] Controls affect both static and interactive modes

**R4 - Output format coverage:**

- [ ] `ALL_TABS` used for all stories
- [ ] `height` control for viewport testing

**General:**

- [ ] State factories extracted to `_fixtures.ts`
- [ ] No hardcoded state in story files
