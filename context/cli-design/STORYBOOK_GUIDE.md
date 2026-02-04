# CLI Storybook Best Practices

Guidelines for creating Storybook stories for CLI output components.

## Core Principle

**Every meaningful CLI flag gets a Storybook control.** Users should be able to explore all output variations without touching code.

## Directory Structure

```
CommandOutput/
  stories/
    _fixtures.ts      # State factories, example data, timeline
    Results.stories.tsx
    Errors.stories.tsx
  mod.ts
  schema.ts
  view.tsx
```

## Standard Controls

Every story includes these base controls:

```typescript
type StoryArgs = {
  height: number        // Terminal viewport height
  interactive: boolean  // Toggle animated vs static
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
  'tty',       // Interactive terminal
  'alt-screen', // Full-screen TUI
  'ci',        // CI mode with colors
  'ci-plain',  // CI mode without colors
  'pipe',      // Piped output
  'log',       // Structured log format
  'json',      // JSON output
  'ndjson',    // Newline-delimited JSON
]
```

## Story Organization

Group by scenario type:

| File | Purpose |
|------|---------|
| `Results.stories.tsx` | Success scenarios, mixed results |
| `Errors.stories.tsx` | Error handling, failures |
| `Overflow.stories.tsx` | Viewport truncation, many items |

## Checklist

- [ ] Every CLI flag has a corresponding control
- [ ] `interactive` toggle for animated vs static view
- [ ] `height` control for viewport testing
- [ ] `useMemo` wraps config dependent on args
- [ ] Timeline factory accepts same config as static state
- [ ] ALL_TABS for output format coverage
- [ ] State factories are typed and reusable
