/**
 * VSCode Workspace Generator
 *
 * Generates a VSCode workspace file that includes all member repos.
 * Output: .vscode/megarepo.code-workspace in the megarepo root.
 */

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'

import {
  type AbsoluteDirPath,
  EffectPath,
  MEMBER_ROOT_DIR,
  type MegarepoConfig,
} from '../config.ts'

/** Options for the VSCode workspace generator */
export interface VscodeGeneratorOptions {
  /** Path to the megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** The megarepo config */
  readonly config: typeof MegarepoConfig.Type
  /** Members to exclude from workspace */
  readonly exclude?: ReadonlyArray<string>
}

interface VscodeWorkspace {
  folders: Array<{ path: string; name?: string }>
  settings?: Record<string, unknown>
}

/**
 * Parse a hex color string to RGB values.
 */
const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const cleaned = hex.replace('#', '')
  return {
    r: parseInt(cleaned.slice(0, 2), 16),
    g: parseInt(cleaned.slice(2, 4), 16),
    b: parseInt(cleaned.slice(4, 6), 16),
  }
}

/**
 * Convert RGB to HSL.
 */
const rgbToHsl = (r: number, g: number, b: number): { h: number; s: number; l: number } => {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0
  let s = 0

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6
        break
      case g:
        h = ((b - r) / d + 2) / 6
        break
      case b:
        h = ((r - g) / d + 4) / 6
        break
    }
  }

  return { h, s, l }
}

/** Helper for HSL to RGB conversion */
const hue2rgb = (p: number, q: number, t: number) => {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

/**
 * Convert HSL to RGB.
 */
const hslToRgb = (h: number, s: number, l: number): { r: number; g: number; b: number } => {
  let r: number, g: number, b: number

  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }

  return {
    r: Math.round(r * 255),
    g: Math.round(g * 255),
    b: Math.round(b * 255),
  }
}

/** Convert a number to a 2-digit hex string */
const toHex = (n: number) => n.toString(16).padStart(2, '0')

/**
 * Convert RGB to hex string.
 */
const rgbToHex = (r: number, g: number, b: number): string => {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Darken a hex color by reducing its lightness.
 * @param hex - The hex color string (e.g., "#22c55e")
 * @param amount - Amount to reduce lightness (0-1, default 0.3)
 */
const darkenHex = (hex: string, amount = 0.3): string => {
  const { r, g, b } = hexToRgb(hex)
  const { h, s, l } = rgbToHsl(r, g, b)
  const newL = Math.max(0, l - amount)
  const rgb = hslToRgb(h, s, newL)
  return rgbToHex(rgb.r, rgb.g, rgb.b)
}

/**
 * Generate color customizations from a single accent color.
 * Creates a consistent "branded" look for titleBar, activityBar, and statusBar.
 * The activity bar uses a darker shade for better contrast.
 */
const generateColorCustomizations = (color: string): Record<string, string> => ({
  'titleBar.activeBackground': color,
  'titleBar.activeForeground': '#FFFFFF',
  'titleBar.inactiveBackground': color,
  'titleBar.inactiveForeground': '#CCCCCC',
  'activityBar.background': darkenHex(color, 0.15),
  'activityBar.foreground': '#FFFFFF',
  'activityBar.inactiveForeground': '#FFFFFF',
  'statusBar.background': color,
  'statusBar.foreground': '#FFFFFF',
})

/**
 * Deep merge two objects. Source values override target values.
 * For nested objects, merges recursively. For arrays and primitives, source wins.
 */
const deepMerge = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = result[key]
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      )
    } else {
      result[key] = sourceVal
    }
  }
  return result
}

/**
 * Generate VSCode workspace content
 */
export const generateVscodeContent = (options: VscodeGeneratorOptions): string => {
  const vscodeConfig = options.config.generators?.vscode
  const excludeSet = new Set(options.exclude ?? vscodeConfig?.exclude ?? [])

  // Paths are relative to .vscode/ directory where the workspace file lives
  const folders: VscodeWorkspace['folders'] = [
    { path: '..', name: '(megarepo root)' },
    ...Object.keys(options.config.members)
      .filter((name) => !excludeSet.has(name))
      .map((name) => ({ path: `../${MEMBER_ROOT_DIR}/${name}`, name })),
  ]

  // Build settings: defaults -> color shorthand -> user settings (in order of precedence)
  let settings: Record<string, unknown> = {
    'files.exclude': {
      '**/.git': true,
      '**/node_modules': true,
      '**/dist': true,
    },
  }

  // Apply color shorthand if provided
  if (vscodeConfig?.color) {
    settings = deepMerge(settings, {
      'workbench.colorCustomizations': generateColorCustomizations(vscodeConfig.color),
    })
  }

  // Apply user settings passthrough (overrides everything)
  if (vscodeConfig?.settings) {
    settings = deepMerge(settings, vscodeConfig.settings as Record<string, unknown>)
  }

  const workspace: VscodeWorkspace = {
    folders,
    settings,
  }

  return JSON.stringify(workspace, null, 2) + '\n'
}

/**
 * Generate VSCode workspace file
 */
export const generateVscode = (options: VscodeGeneratorOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    const content = generateVscodeContent(options)
    const vscodeDir = EffectPath.ops.join(
      options.megarepoRoot,
      EffectPath.unsafe.relativeDir('.vscode/'),
    )
    const outputPath = EffectPath.ops.join(
      vscodeDir,
      EffectPath.unsafe.relativeFile('megarepo.code-workspace'),
    )

    // Ensure .vscode directory exists
    yield* fs.makeDirectory(vscodeDir, { recursive: true })
    yield* fs.writeFileString(outputPath, content)

    return { path: outputPath, content }
  })
