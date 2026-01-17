/**
 * Live metrics reporter - displays FPS/latency overlay during benchmarks
 */

import type { BenchMetrics } from '../metrics.ts'

const RESET = '\x1b[0m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'

/** Format a single metric with color based on threshold */
const formatMetric = (
  label: string,
  value: number,
  unit: string,
  thresholds?: { good: number; warn: number },
): string => {
  let color = CYAN
  if (thresholds) {
    if (value <= thresholds.good) color = GREEN
    else if (value <= thresholds.warn) color = YELLOW
    else color = RED
  }
  return `${DIM}${label}${RESET} ${color}${value.toFixed(1)}${unit}${RESET}`
}

/** Render the live metrics line */
export const renderMetricsLine = (metrics: BenchMetrics, targetFps = 12.5): string => {
  const fpsColor = metrics.fps >= targetFps * 0.9 ? GREEN : metrics.fps >= targetFps * 0.7 ? YELLOW : RED
  const fps = `${DIM}FPS${RESET} ${fpsColor}${metrics.fps.toFixed(1)}${RESET}${DIM}/${targetFps}${RESET}`

  const parts = [
    fps,
    formatMetric('Frame', metrics.frameTimeMs, 'ms', { good: 10, warn: 50 }),
    formatMetric('Events/s', metrics.eventThroughput, '', { good: 10000, warn: 50000 }),
    formatMetric('State', metrics.stateUpdateTimeMs, 'ms', { good: 1, warn: 5 }),
    formatMetric('Render', metrics.renderTimeMs, 'ms', { good: 5, warn: 20 }),
    formatMetric('Mem', metrics.memoryMB, 'MB', { good: 100, warn: 200 }),
  ]

  return `┌─ BENCH: ${parts.join(' │ ')} ─┐`
}

/** Render a progress bar */
export const renderProgressBar = (progress: number, width = 20): string => {
  const filled = Math.floor(progress * width)
  const empty = width - filled
  return `[${GREEN}${'█'.repeat(filled)}${DIM}${'░'.repeat(empty)}${RESET}]`
}

/** Render elapsed time */
export const renderElapsed = (startTime: number): string => {
  const elapsed = (Date.now() - startTime) / 1000
  return `${DIM}${elapsed.toFixed(1)}s${RESET}`
}

/** Full benchmark header with scenario info */
export const renderBenchHeader = (
  scenario: string,
  config: { tasks?: number; eventsPerSec?: number; duration?: number },
): string => {
  const parts = [
    `${CYAN}${scenario}${RESET}`,
    config.tasks ? `${config.tasks} tasks` : null,
    config.eventsPerSec ? `${config.eventsPerSec} events/s` : null,
    config.duration ? `${config.duration}s` : null,
  ].filter(Boolean)

  return `┌─ ${parts.join(' │ ')} ─┐`
}

/** Render comparison table */
export const renderComparisonTable = (comparisons: {
  baseline: { progress: number; events: number; overhead?: undefined }
  noRenderer: { progress: number; events: number; overhead: number }
  fullSystem: { progress: number; events: number; overhead: number }
}): string[] => {
  const lines: string[] = []
  const width = 65

  lines.push('┌' + '─'.repeat(width) + '┐')
  lines.push(
    `│ ${CYAN}COMPARISON${RESET}${' '.repeat(width - 12)}│`,
  )
  lines.push('├' + '─'.repeat(width) + '┤')

  const formatRow = (
    name: string,
    progress: number,
    events: number,
    overhead?: number,
  ): string => {
    const bar = renderProgressBar(progress, 20)
    const pct = `${(progress * 100).toFixed(0)}%`.padStart(4)
    const evtStr = `events: ${events.toLocaleString()}`.padEnd(18)
    const overheadStr = overhead !== undefined ? `overhead: ${overhead.toFixed(1)}%` : ''
    const content = `${name.padEnd(14)} ${bar} ${pct}  ${evtStr} ${overheadStr}`
    return `│ ${content.padEnd(width - 2)} │`
  }

  lines.push(formatRow('Baseline:', comparisons.baseline.progress, comparisons.baseline.events))
  lines.push(formatRow('No renderer:', comparisons.noRenderer.progress, comparisons.noRenderer.events, comparisons.noRenderer.overhead))
  lines.push(formatRow('Full system:', comparisons.fullSystem.progress, comparisons.fullSystem.events, comparisons.fullSystem.overhead))

  lines.push('└' + '─'.repeat(width) + '┘')

  return lines
}
