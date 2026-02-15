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

/** RGB color values */
interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** HSL color values */
interface Hsl {
  readonly h: number
  readonly s: number
  readonly l: number
}

/**
 * Convert RGB to HSL.
 */
const rgbToHsl = ({ r, g, b }: Rgb): Hsl => {
  let rNorm = r / 255
  let gNorm = g / 255
  let bNorm = b / 255
  const max = Math.max(rNorm, gNorm, bNorm)
  const min = Math.min(rNorm, gNorm, bNorm)
  const l = (max + min) / 2
  let h = 0
  let s = 0

  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rNorm:
        h = ((gNorm - bNorm) / d + (gNorm < bNorm ? 6 : 0)) / 6
        break
      case gNorm:
        h = ((bNorm - rNorm) / d + 2) / 6
        break
      case bNorm:
        h = ((rNorm - gNorm) / d + 4) / 6
        break
    }
  }

  return { h, s, l }
}

/** Helper for HSL to RGB conversion */
const hue2rgb = ({ p, q, t }: { p: number; q: number; t: number }) => {
  let tNorm = t
  if (tNorm < 0) tNorm += 1
  if (tNorm > 1) tNorm -= 1
  if (tNorm < 1 / 6) return p + (q - p) * 6 * tNorm
  if (tNorm < 1 / 2) return q
  if (tNorm < 2 / 3) return p + (q - p) * (2 / 3 - tNorm) * 6
  return p
}

/**
 * Convert HSL to RGB.
 */
const hslToRgb = ({ h, s, l }: Hsl): Rgb => {
  let r: number, g: number, b: number

  if (s === 0) {
    r = g = b = l
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb({ p, q, t: h + 1 / 3 })
    g = hue2rgb({ p, q, t: h })
    b = hue2rgb({ p, q, t: h - 1 / 3 })
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
const rgbToHex = ({ r, g, b }: Rgb): string => {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Darken a hex color by reducing its lightness.
 * @param hex - The hex color string (e.g., "#22c55e")
 * @param amount - Amount to reduce lightness (0-1, default 0.3)
 */
const darkenHex = ({ hex, amount = 0.3 }: { hex: string; amount?: number }): string => {
  const rgb = hexToRgb(hex)
  const { h, s, l } = rgbToHsl(rgb)
  const newL = Math.max(0, l - amount)
  const newRgb = hslToRgb({ h, s, l: newL })
  return rgbToHex(newRgb)
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
  'activityBar.background': darkenHex({ hex: color, amount: 0.15 }),
  'activityBar.foreground': '#FFFFFF',
  'activityBar.inactiveForeground': '#FFFFFF',
  'statusBar.background': color,
  'statusBar.foreground': '#FFFFFF',
})

/**
 * Deep merge two objects. Source values override target values.
 * For nested objects, merges recursively. For arrays and primitives, source wins.
 */
const deepMerge = ({
  target,
  source,
}: {
  target: Record<string, unknown>
  source: Record<string, unknown>
}): Record<string, unknown> => {
  const result = { ...target }
  for (const key of Object.keys(source)) {
    const sourceVal = source[key]
    const targetVal = result[key]
    if (
      sourceVal !== null &&
      typeof sourceVal === 'object' &&
      Array.isArray(sourceVal) === false &&
      targetVal !== null &&
      typeof targetVal === 'object' &&
      Array.isArray(targetVal) === false
    ) {
      result[key] = deepMerge({
        target: targetVal as Record<string, unknown>,
        source: sourceVal as Record<string, unknown>,
      })
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

  // Apply color: prefer env var (if configured) over static color field
  const colorFromEnv = vscodeConfig?.colorEnvVar ? process.env[vscodeConfig.colorEnvVar] : undefined
  const color = colorFromEnv ?? vscodeConfig?.color
  if (color) {
    settings = deepMerge({
      target: settings,
      source: {
        'workbench.colorCustomizations': generateColorCustomizations(color),
      },
    })
  }

  // Apply user settings passthrough (overrides everything)
  if (vscodeConfig?.settings) {
    settings = deepMerge({
      target: settings,
      source: vscodeConfig.settings as Record<string, unknown>,
    })
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
