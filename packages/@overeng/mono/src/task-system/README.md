# Task System

Graph-based task execution with streaming output, dependency resolution, and pluggable rendering.

## Terminology

### Execution Modes

- **Inline rendering**: Updates progress in-place using ANSI cursor positioning. Output remains in terminal history after completion. Works everywhere (CI, interactive, pipes).

- **Alternate screen**: Full-screen TUI mode that takes over the terminal. On exit, returns to previous screen state with no trace. Requires terminal support (doesn't work in CI).

- **CI mode**: Outputs using CI-specific markup (e.g., GitHub Actions groups `::group::`). Provides collapsible sections in CI logs.

### Task System Concepts

- **Task Definition**: Declarative specification of a task with ID, name, dependencies, and an Effect to execute.

- **Task Graph**: DAG (Directed Acyclic Graph) of tasks with dependency relationships. Automatically resolved via topological sorting.

- **Task Event**: Atomic state change during task execution (`registered`, `started`, `stdout`, `stderr`, `completed`).

- **Task State**: Aggregate state of a task built by reducing events over time.

- **Renderer**: Component that consumes TaskSystemState and produces output (inline, CI groups, alternate screen, etc.).

## Design Decisions

### 1. Event-Driven Architecture

**Decision**: Use event streams with pure reducers instead of direct state mutations.

**Rationale**:

- Events are serializable → can log, replay, debug
- Pure reducers → easy to test
- Clean separation: execution → events → state → rendering
- Can add event listeners for telemetry, logging, etc.

**Trade-off**: More code than direct mutations, but worth it for testability.

### 2. Topological Execution with Effect Workflow

**Decision**: Use Effect Workflow for task orchestration with custom topological grouping.

**Rationale**:

- Workflow provides robust DAG execution with persistence (we use in-memory)
- Automatic dependency tracking and parallel execution
- Built-in error handling and retries
- Can add durability later if needed

**Implementation**: Tasks grouped into "levels" where each level executes in parallel:

```
Level 0: [build-a, build-b, lint]     // No dependencies
Level 1: [test]                        // Depends on builds
Level 2: [deploy]                      // Depends on test
```

### 3. Pluggable Renderers

**Decision**: Define `TaskRenderer` interface, provide multiple implementations.

**Rationale**:

- Different environments need different output (CI vs interactive)
- Easy to add custom renderers for special cases
- Keeps rendering logic separate from execution

**Available Renderers**:

- `inlineRenderer()` - Default, works everywhere
- `ciRenderer()` - GitHub Actions groups (coming soon)
- `alternateScreenRenderer()` - OpenTui integration (future)

### 4. Unified Task API

**Decision**: Support both shell commands and arbitrary Effects through a unified API.

**Rationale**:

- Most tasks are shell commands (bun install, tsc, vitest)
- Some tasks need Effect composition (file operations, HTTP calls)
- Should feel natural for both use cases

**API Design** (see below for options).

### 5. Show Recent Logs Per Task

**Decision**: Renderer shows status + last 1-2 log lines for running/failed tasks.

**Rationale**:

- Provides context without overwhelming output
- Shows what's happening "right now"
- Failed tasks show error details in final summary

**Example**:

```
◐ Build Package A (1.2s)
  │ Compiling 147 files...
✓ Build Package B (0.8s)
✗ Lint Code (0.5s)
  │ Error: Unused variable 'foo' at line 42
```

## Architecture

```
┌─────────────────┐
│  Task Graph     │  Define tasks with dependencies
│  Definition     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Workflow       │  Resolve dependencies, execute tasks
│  Engine         │  in topological order with parallelism
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Event Stream   │  Task lifecycle events
│                 │  (started, stdout, stderr, completed)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  State Reducer  │  Pure function: (state, event) => newState
│                 │  Builds aggregate TaskSystemState
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Renderer       │  Consumes state, produces output
│  (pluggable)    │  (inline, CI groups, alternate screen)
└─────────────────┘
```

## API Design Options

### Option A: Discriminated Union (Type-Safe)

```typescript
type TaskDef<TId extends string> =
  | {
      type: 'effect'
      id: TId
      name: string
      dependencies?: TId[]
      effect: Effect.Effect<void, unknown, unknown>
    }
  | {
      type: 'command'
      id: TId
      name: string
      dependencies?: TId[]
      command: string
      args: string[]
      cwd?: string
      env?: Record<string, string>
    }

// Usage
const tasks: TaskDef<string>[] = [
  {
    type: 'command',
    id: 'install',
    name: 'Install dependencies',
    command: 'bun',
    args: ['install'],
  },
  {
    type: 'effect',
    id: 'custom',
    name: 'Custom task',
    effect: Effect.gen(function* () {
      // arbitrary Effect code
    }),
  },
]
```

**Pros**: Type-safe, clear distinction
**Cons**: More verbose, can't mix command + custom Effect easily

### Option B: Helper Functions (Ergonomic)

```typescript
interface TaskDef<TId extends string, A, E, R> {
  id: TId
  name: string
  dependencies?: TId[]
  effect: Effect.Effect<A, E, R>
}

// Helpers
const commandTask = <TId extends string>(
  id: TId,
  name: string,
  command: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; dependencies?: TId[] },
): TaskDef<TId, void, CommandError, CommandExecutor> => ({
  id,
  name,
  dependencies: options?.dependencies,
  effect: runCommandWithCapture({ command, args, ...options }),
})

const effectTask = <TId extends string, A, E, R>(
  id: TId,
  name: string,
  effect: Effect.Effect<A, E, R>,
  options?: { dependencies?: TId[] },
): TaskDef<TId, A, E, R> => ({
  id,
  name,
  dependencies: options?.dependencies,
  effect,
})

// Usage
const tasks = [
  commandTask('install', 'Install dependencies', 'bun', ['install']),
  commandTask('typecheck', 'Type check', 'tsc', ['--build'], {
    dependencies: ['install'],
  }),
  effectTask('notify', 'Send notification', sendSlackNotification(), {
    dependencies: ['typecheck'],
  }),
]
```

**Pros**: Clean, flexible, can compose Effects before passing
**Cons**: Type inference can be tricky with dependencies

### Option C: Builder Pattern (Fluent)

```typescript
class TaskBuilder<TId extends string> {
  command(id: TId, name: string, cmd: string, args: string[]): TaskDef<TId, ...>
  effect<A, E, R>(id: TId, name: string, effect: Effect.Effect<A, E, R>): TaskDef<TId, ...>
  depends(...ids: TId[]): this
  cwd(path: string): this
  env(vars: Record<string, string>): this
}

// Usage
const tasks = new TaskBuilder()
  .command('install', 'Install', 'bun', ['install'])
  .command('typecheck', 'Type Check', 'tsc', ['--build'])
    .depends('install')
  .effect('notify', 'Notify', sendSlackNotification())
    .depends('typecheck')
  .build()
```

**Pros**: Very fluent, chainable
**Cons**: More complex, overkill for simple cases

### Option D: Unified Factory (Recommended)

```typescript
interface TaskDef<TId extends string, A, E, R> {
  id: TId
  name: string
  dependencies?: TId[]
  effect: Effect.Effect<A, E, R>
}

// Single factory with overloads
function task<TId extends string>(
  id: TId,
  name: string,
  effect: Effect.Effect<unknown, unknown, unknown>,
  options?: { dependencies?: TId[] },
): TaskDef<TId, unknown, unknown, unknown>

function task<TId extends string>(
  id: TId,
  name: string,
  command: { cmd: string; args: string[]; cwd?: string; env?: Record<string, string> },
  options?: { dependencies?: TId[] },
): TaskDef<TId, void, CommandError, CommandExecutor>

// Usage
const tasks = [
  task('install', 'Install dependencies', {
    cmd: 'bun',
    args: ['install'],
  }),

  task(
    'typecheck',
    'Type check',
    {
      cmd: 'tsc',
      args: ['--build'],
    },
    {
      dependencies: ['install'],
    },
  ),

  task(
    'notify',
    'Send notification',
    Effect.gen(function* () {
      yield* sendSlackMessage('Build complete!')
    }),
  ),
]
```

**Pros**: Clean, minimal, easy to use
**Cons**: Overload resolution can be tricky in TypeScript

## Workflow Integration Options

### Option 1: Direct Workflow Activities

Use Workflow's Activity concept where each task is an Activity:

```typescript
import { Workflow } from '@effect/workflow'

const graph = Workflow.make('build-pipeline', {
  activities: {
    install: runCommand('bun', ['install']),
    typecheck: runCommand('tsc', ['--build']),
    test: runCommand('vitest', ['run']),
  },
  workflow: function* () {
    yield* Activity.execute('install')
    yield* Activity.all([Activity.execute('typecheck'), Activity.execute('test')])
  },
})
```

**Pros**: Native workflow support, can add persistence later
**Cons**: More verbose, less declarative

### Option 2: Workflow + Custom Orchestration (Recommended)

Use Workflow engine for DAG execution, wrap in our task API:

```typescript
// Under the hood
const executeTaskGraph = <TId extends string>(tasks: TaskDef<TId>[]) => {
  // Convert task graph to Workflow activities
  const activities = Object.fromEntries(tasks.map((t) => [t.id, () => executeTask(t)]))

  // Create workflow with dependency resolution
  const workflow = Workflow.make('task-graph', {
    activities,
    workflow: function* () {
      const levels = topologicalSort(tasks)
      for (const level of levels) {
        yield* Activity.all(level.map((id) => Activity.execute(id)))
      }
    },
  })

  return WorkflowEngine.run(workflow)
}
```

**Pros**: Best of both worlds - declarative API + workflow engine
**Cons**: Indirection layer between API and workflow

### Option 3: Pure Topological Sort (Current Prototype)

Don't use Workflow, just topological sort + Effect.all:

```typescript
const levels = topologicalSort(tasks)
for (const level of levels) {
  yield *
    Effect.all(
      level.map((task) => executeTask(task)),
      { concurrency: 'unbounded' },
    )
}
```

**Pros**: Simple, no dependencies, easy to understand
**Cons**: Miss out on workflow features (persistence, retries, monitoring)

## Usage Examples

### Basic Command Execution

```typescript
import { task, runTaskGraph, inlineRenderer } from '@overeng/mono/task-system'

const tasks = [
  task('format', 'Format code', {
    cmd: 'oxfmt',
    args: ['.'],
  }),

  task('lint', 'Lint code', {
    cmd: 'oxlint',
    args: ['--deny-warnings'],
  }),
]

const renderer = inlineRenderer()
const result =
  yield *
  runTaskGraph(tasks, {
    onStateChange: (state) => renderer.render(state),
  })

yield * renderer.renderFinal(result.state)
```

### With Dependencies

```typescript
const tasks = [
  task('install', 'Install dependencies', {
    cmd: 'bun',
    args: ['install'],
  }),

  task(
    'typecheck',
    'Type check',
    {
      cmd: 'tsc',
      args: ['--build'],
    },
    {
      dependencies: ['install'],
    },
  ),

  task(
    'test',
    'Run tests',
    {
      cmd: 'vitest',
      args: ['run'],
    },
    {
      dependencies: ['install'],
    },
  ),

  task(
    'deploy',
    'Deploy',
    {
      cmd: 'fly',
      args: ['deploy'],
    },
    {
      dependencies: ['typecheck', 'test'],
    },
  ),
]
```

### Mixed Command + Effect

```typescript
const tasks = [
  task('build', 'Build project', {
    cmd: 'bun',
    args: ['build'],
  }),

  task(
    'upload',
    'Upload artifacts',
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const files = yield* fs.readDirectory('dist')

      for (const file of files) {
        yield* uploadToS3(file)
      }
    }),
    { dependencies: ['build'] },
  ),
]
```

## Renderer Details

### Inline Renderer Output

```
◐ Build Package A (1.2s)
  │ Compiling src/index.ts...
  │ Compiling src/utils.ts...
✓ Build Package B (0.8s)
○ Run Tests
○ Deploy
```

**Features**:

- Status icons: `○` pending, `◐` running, `✓` success, `✗` failed
- Live duration updates
- Last 1-2 log lines for running tasks
- Updates in-place using ANSI cursor positioning

### CI Renderer Output (Future)

```
::group::Build Package A
Compiling src/index.ts...
Compiling src/utils.ts...
::endgroup::

::group::Build Package B
Compiling src/main.ts...
::endgroup::
```

**Features**:

- Collapsible sections in GitHub Actions
- Full output for each task
- No live updates (sequential)

## Migration Plan

### Phase 1: Core System ✅

- ✅ Event-driven architecture
- ✅ Topological sort
- ✅ Inline renderer
- ✅ Basic prototype

### Phase 2: Command Execution (Next)

- 🔲 Add command execution with output capture
- 🔲 Emit stdout/stderr events
- 🔲 Update renderer to show recent logs
- 🔲 Design final API (Option D recommended)

### Phase 3: Workflow Integration

- 🔲 Integrate @effect/workflow for orchestration
- 🔲 Test with complex graphs (100+ tasks)
- 🔲 Add workflow monitoring/telemetry

### Phase 4: Migrate Existing Commands

- ✅ Migrate `mono install`
- ✅ Migrate `mono check`
- ✅ Remove old TaskRunner

### Phase 5: Advanced Features

- 🔲 CI renderer with GitHub Actions groups
- 🔲 Task filtering/selection
- 🔲 Incremental execution (skip unchanged)
- 🔲 OpenTui alternate screen renderer

## Performance Considerations

- **Debouncing**: Renderer updates debounced to 50-100ms to avoid flickering
- **State updates**: Pure reducers + SubscriptionRef for efficient updates
- **Parallelism**: Unbounded concurrency within each level (Effect manages fibers)
- **Memory**: TaskState accumulates stdout/stderr - may need truncation for very verbose tasks

## Open Questions

1. **Task result passing**: Should tasks be able to pass data to dependent tasks?
2. **Task cancellation**: Should we support cancelling dependent tasks on failure?
3. **Retry policies**: Built-in or leave to user's Effect?
4. **Caching**: Should we cache task results for incremental execution?
