#!/usr/bin/env bun
/**
 * Visual Stress Test with Live FPS Metrics
 *
 * This renders directly to the terminal (not using pi-tui) to test
 * raw rendering performance and provide live visual feedback.
 *
 * Run: bun packages/@overeng/mono/stress-test/visual-stress.ts
 *
 * Output: Writes frame timing data to stress-test-results.json for verification
 */

import { writeFileSync } from 'node:fs'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const BLUE = '\x1b[34m'
const MAGENTA = '\x1b[35m'

const CLEAR_LINE = '\x1b[2K'
const CURSOR_UP = (n: number) => `\x1b[${n}A`
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

interface FrameMetrics {
  frameNumber: number
  timestamp: number
  frameTimeMs: number
  fps: number
  memoryMB: number
}

interface TestResults {
  config: {
    durationSeconds: number
    targetFps: number
    progressBarCount: number
  }
  frames: FrameMetrics[]
  summary: {
    totalFrames: number
    avgFrameTimeMs: number
    minFrameTimeMs: number
    maxFrameTimeMs: number
    avgFps: number
    droppedFrames: number
    percentDropped: number
  }
}

const hrtime = () => {
  const [sec, nsec] = process.hrtime()
  return sec * 1000 + nsec / 1e6
}

/** Render a progress bar */
// oxlint-disable-next-line overeng/named-args -- simple render function with defaults
const renderProgressBar = (progress: number, width = 30, color = GREEN): string => {
  const filled = Math.floor(progress * width)
  const empty = width - filled
  const bar = `${color}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}`
  const pct = `${(progress * 100).toFixed(0)}%`.padStart(4)
  return `[${bar}] ${pct}`
}

/** Render the FPS meter */
// oxlint-disable-next-line overeng/named-args -- simple render function with clear params
const renderFpsMeter = (fps: number, frameTimeMs: number, targetFps: number): string => {
  const fpsRatio = fps / targetFps
  const fpsColor = fpsRatio >= 0.95 ? GREEN : fpsRatio >= 0.7 ? YELLOW : RED
  const frameColor = frameTimeMs < 20 ? GREEN : frameTimeMs < 50 ? YELLOW : RED

  return [
    `${BOLD}┌─ LIVE FPS ─────────────────────────────────────────────────┐${RESET}`,
    `${BOLD}│${RESET} FPS: ${fpsColor}${fps.toFixed(1).padStart(5)}${RESET}/${targetFps} │ Frame: ${frameColor}${frameTimeMs.toFixed(1).padStart(5)}ms${RESET} │ Mem: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1).padStart(5)}MB ${BOLD}│${RESET}`,
    `${BOLD}└─────────────────────────────────────────────────────────────┘${RESET}`,
  ].join('\n')
}

/** Render spinner animation */
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const getSpinner = (frame: number): string => spinnerFrames[frame % spinnerFrames.length]

/** Simulated log messages for install-like operations */
const logMessages = [
  'Resolving dependencies...',
  'Downloading @effect/platform@0.71.1...',
  'Downloading effect@3.12.5...',
  'Downloading @effect/schema@0.76.2...',
  'Installing node_modules...',
  'Linking packages...',
  'Building native modules...',
  'Compiling TypeScript...',
  'Running postinstall scripts...',
  'Validating lockfile...',
  'Fetching registry metadata...',
  'Deduplicating dependencies...',
  'Downloading zod@3.24.1...',
  'Downloading typescript@5.7.2...',
  'Downloading vite@6.0.7...',
  'Extracting tarball...',
  'Verifying checksums...',
  'Updating package-lock.json...',
]

interface ProgressItem {
  name: string
  progress: number
  speed: number
  color: string
  logMessage: string
  logUpdateCounter: number
}

/** Main visual stress test */
const runVisualStress = async (config: {
  durationSeconds: number
  targetFps: number
  progressBarCount: number
}) => {
  const { durationSeconds, targetFps, progressBarCount } = config
  const frameIntervalMs = 1000 / targetFps

  const frames: FrameMetrics[] = []
  const startTime = hrtime()
  const endTime = startTime + durationSeconds * 1000

  // Simulated package names
  const packageNames = [
    '@overeng/mono',
    '@overeng/effect-ai',
    '@effect/platform',
    'effect',
    '@overeng/utils',
    'typescript',
    '@effect/schema',
    'vite',
    '@overeng/effect-path',
    'zod',
    '@effect/cli',
    'vitest',
    '@overeng/effect-rpc',
    'esbuild',
    '@effect/opentelemetry',
    'biome',
    'turbo',
    'prettier',
    'eslint',
    '@effect/experimental',
  ]

  // Initialize progress items
  const progressItems: ProgressItem[] = Array.from({ length: progressBarCount }, (_, i) => ({
    name: packageNames[i % packageNames.length],
    progress: 0,
    speed: 0.3 + Math.random() * 1.5, // Random speed
    color: [GREEN, CYAN, BLUE, MAGENTA, YELLOW][i % 5],
    logMessage: logMessages[Math.floor(Math.random() * logMessages.length)],
    logUpdateCounter: Math.floor(Math.random() * 10), // Stagger initial updates
  }))

  // Calculate total lines we'll render
  const headerLines = 3
  const progressLines = progressBarCount
  const footerLines = 2
  const totalLines = headerLines + progressLines + footerLines

  // Hide cursor and print initial newlines
  process.stdout.write(HIDE_CURSOR)
  process.stdout.write('\n'.repeat(totalLines))

  let frameNumber = 0
  let lastFrameTime = hrtime()
  let fpsWindow: number[] = []

  const render = () => {
    const now = hrtime()
    const frameTime = now - lastFrameTime
    lastFrameTime = now

    // Calculate FPS from rolling window
    fpsWindow.push(1000 / frameTime)
    if (fpsWindow.length > 20) fpsWindow.shift()
    const currentFps = fpsWindow.reduce((a, b) => a + b, 0) / fpsWindow.length

    // Record metrics
    frames.push({
      frameNumber,
      timestamp: now - startTime,
      frameTimeMs: frameTime,
      fps: currentFps,
      memoryMB: process.memoryUsage().heapUsed / 1024 / 1024,
    })

    // Update progress items
    for (const item of progressItems) {
      item.progress = Math.min(1, item.progress + item.speed / 100)
      item.logUpdateCounter++

      // Update log message periodically (every ~5-15 frames)
      if (item.logUpdateCounter > 5 + Math.random() * 10) {
        item.logMessage = logMessages[Math.floor(Math.random() * logMessages.length)]
        item.logUpdateCounter = 0
      }

      if (item.progress >= 1) {
        item.progress = 0
        item.speed = 0.3 + Math.random() * 1.5
        item.logMessage = logMessages[Math.floor(Math.random() * logMessages.length)]
      }
    }

    // Build output
    const lines: string[] = []

    // Header with FPS meter
    lines.push(renderFpsMeter(currentFps, frameTime, targetFps))

    // Progress bars with live log messages
    for (const item of progressItems) {
      const spinner = getSpinner(frameNumber)
      const bar = renderProgressBar(item.progress, 20, item.color)
      const name = item.name.padEnd(22)
      const log = `${DIM}${item.logMessage.slice(0, 35).padEnd(35)}${RESET}`
      lines.push(`${CLEAR_LINE}${spinner} ${name} ${bar} ${log}`)
    }

    // Footer
    const elapsed = (now - startTime) / 1000
    const remaining = Math.max(0, durationSeconds - elapsed)
    lines.push('')
    lines.push(
      `${DIM}Elapsed: ${elapsed.toFixed(1)}s │ Remaining: ${remaining.toFixed(1)}s │ Frame: ${frameNumber}${RESET}`,
    )

    // Move cursor up and render
    process.stdout.write(CURSOR_UP(totalLines))
    process.stdout.write(lines.join('\n') + '\n')

    frameNumber++
  }

  // Run the stress test
  while (hrtime() < endTime) {
    const frameStart = hrtime()
    render()
    const frameEnd = hrtime()

    // Sleep for remaining frame time
    const sleepMs = Math.max(0, frameIntervalMs - (frameEnd - frameStart))
    if (sleepMs > 0) {
      // eslint-disable-next-line no-await-in-loop -- intentional for animation frame timing
      await new Promise((r) => setTimeout(r, sleepMs))
    }
  }

  // Final render
  render()

  // Show cursor
  process.stdout.write(SHOW_CURSOR)

  // Calculate summary
  const frameTimes = frames.map((f) => f.frameTimeMs)
  const avgFrameTime = frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length
  const minFrameTime = Math.min(...frameTimes)
  const maxFrameTime = Math.max(...frameTimes)
  const avgFps = frames.map((f) => f.fps).reduce((a, b) => a + b, 0) / frames.length
  const droppedFrames = frameTimes.filter((t) => t > frameIntervalMs * 1.5).length
  const percentDropped = (droppedFrames / frames.length) * 100

  const results: TestResults = {
    config,
    frames,
    summary: {
      totalFrames: frames.length,
      avgFrameTimeMs: avgFrameTime,
      minFrameTimeMs: minFrameTime,
      maxFrameTimeMs: maxFrameTime,
      avgFps,
      droppedFrames,
      percentDropped,
    },
  }

  // Write results to file
  const resultsPath =
    '/Users/schickling/Code/overengineeringstudio/dotdot/effect-utils/packages/@overeng/mono/stress-test/stress-test-results.json'
  writeFileSync(resultsPath, JSON.stringify(results, null, 2))

  // Print summary
  console.log('\n')
  console.log('╔═══════════════════════════════════════════════════════════════╗')
  console.log('║                    STRESS TEST COMPLETE                       ║')
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log(
    `║  Total frames: ${frames.length.toString().padStart(6)}                                      ║`,
  )
  console.log(
    `║  Avg FPS:      ${avgFps.toFixed(1).padStart(6)} (target: ${targetFps})                          ║`,
  )
  console.log(
    `║  Avg frame:    ${avgFrameTime.toFixed(1).padStart(6)}ms                                    ║`,
  )
  console.log(
    `║  Min frame:    ${minFrameTime.toFixed(1).padStart(6)}ms                                    ║`,
  )
  console.log(
    `║  Max frame:    ${maxFrameTime.toFixed(1).padStart(6)}ms                                    ║`,
  )
  console.log(
    `║  Dropped:      ${droppedFrames.toString().padStart(6)} (${percentDropped.toFixed(1)}%)                            ║`,
  )
  console.log('╠═══════════════════════════════════════════════════════════════╣')
  console.log(`║  Results saved to: stress-test-results.json                   ║`)
  console.log('╚═══════════════════════════════════════════════════════════════╝')

  return results
}

// Parse args
const args = process.argv.slice(2)
// oxlint-disable-next-line overeng/named-args -- simple CLI arg parser utility
const getArg = (name: string, defaultValue: number): number => {
  const idx = args.findIndex((a) => a === `--${name}`)
  if (idx >= 0 && args[idx + 1]) {
    return parseInt(args[idx + 1], 10)
  }
  return defaultValue
}

const config = {
  durationSeconds: getArg('duration', 10),
  targetFps: getArg('fps', 30),
  progressBarCount: getArg('bars', 20),
}

console.log('╔═══════════════════════════════════════════════════════════════╗')
console.log('║                 VISUAL STRESS TEST                            ║')
console.log('╠═══════════════════════════════════════════════════════════════╣')
console.log(
  `║  Duration: ${config.durationSeconds}s │ Target FPS: ${config.targetFps} │ Bars: ${config.progressBarCount}`.padEnd(
    64,
  ) + '║',
)
console.log('╚═══════════════════════════════════════════════════════════════╝')
console.log('')

runVisualStress(config)
