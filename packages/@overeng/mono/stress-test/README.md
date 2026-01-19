# Task System Stress Test Suite

Performance benchmarking and stress testing for the task system rendering.

## Quick Start

```bash
# Visual stress test with live FPS meter and animated progress bars
bun packages/@overeng/mono/stress-test/visual-stress.ts

# Comparison benchmark (task system overhead)
bun packages/@overeng/mono/stress-test/run.ts --quick
```

## Visual Stress Test

The `visual-stress.ts` script renders directly to terminal (not using pi-tui):

- **Live FPS meter** at the top showing current framerate and frame time
- **Animated progress bars** with spinners and colors
- **Memory usage** tracking
- **Elapsed/remaining time** footer

### Usage

```bash
# Default: 10s, 30 FPS target, 20 progress bars
bun packages/@overeng/mono/stress-test/visual-stress.ts

# Custom options
bun packages/@overeng/mono/stress-test/visual-stress.ts --duration 30 --fps 60 --bars 50
```

### Verification

Output is saved to `stress-test-results.json` for programmatic verification:

```bash
# Check summary
cat stress-test-results.json | jq '.summary'

# Check average frame time (should be close to 1000/targetFps)
cat stress-test-results.json | jq '.summary.avgFrameTimeMs'

# Check dropped frames percentage (should be low)
cat stress-test-results.json | jq '.summary.percentDropped'
```

## Comparison Benchmark

Compares task system overhead against raw Effect execution:

```bash
bun packages/@overeng/mono/stress-test/run.ts --quick
```

### Scenarios

| Scenario        | Description                                |
| --------------- | ------------------------------------------ |
| `comparison`    | Baseline vs task system overhead (default) |
| `rapid-events`  | High-frequency event stress test           |
| `progress-bars` | Visual complexity with animated progress   |
| `all`           | Run all scenarios                          |

### Options

```
--tasks N       Number of tasks (default: 50)
--events N      Events per second (default: 1000)
--duration N    Duration in seconds (default: 10)
--concurrency N Concurrency limit (default: 8)
--quick         Quick test (5s, fewer tasks)
```

## Interpreting Results

**Comparison benchmark:**

- **Coordination overhead**: Task system scheduling vs raw Effect
- **Rendering overhead**: Full system vs no-renderer mode
- **Target**: < 10% total overhead

**Visual stress test:**

- **Avg frame time**: Should be close to `1000 / targetFps`
- **Dropped frames**: Frames > 1.5x target time
- **Memory**: Watch for leaks during long runs
