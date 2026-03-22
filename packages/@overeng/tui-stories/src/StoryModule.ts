/**
 * Parse Storybook CSF (Component Story Format) modules into structured data.
 *
 * CSF modules export a `default` Meta and named StoryObj exports.
 * This module extracts and normalizes that structure without coupling
 * to Storybook's runtime — only the data shape matters.
 */

import type { ReactElement } from 'react'

// =============================================================================
// Types
// =============================================================================

/** A single control type from Storybook argTypes */
export type ArgTypeControl =
  | { readonly type: 'boolean' }
  | { readonly type: 'select'; readonly options: readonly string[] }
  | { readonly type: 'text' }
  | { readonly type: 'number' }
  | { readonly type: 'range'; readonly min?: number; readonly max?: number; readonly step?: number }

/** A single argType entry */
export interface ArgType {
  readonly description?: string | undefined
  readonly control: ArgTypeControl
  readonly if?: { readonly arg: string } | undefined
}

/** Parsed story metadata from a CSF module's default export */
export interface StoryMeta {
  readonly title: string
  readonly args: Record<string, unknown>
  readonly argTypes: Record<string, ArgType>
}

/** A resolved story with merged args from meta + story level */
export interface ResolvedStory {
  readonly name: string
  readonly title: string
  readonly id: string
  readonly render: (args: Record<string, unknown>) => ReactElement
  readonly args: Record<string, unknown>
  readonly argTypes: Record<string, ArgType>
  readonly filePath: string
}

/** A parsed CSF module containing meta and stories */
export interface ParsedStoryModule {
  readonly meta: StoryMeta
  readonly stories: readonly ResolvedStory[]
  readonly filePath: string
}

/** Raw module exports from a dynamic import of a .stories.tsx file */
export type RawStoryModuleExports = Record<string, unknown>

// =============================================================================
// Parsing
// =============================================================================

/** Normalize shorthand control syntax to the canonical object form */
const normalizeControl = (raw: unknown): ArgTypeControl | undefined => {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') {
    switch (raw) {
      case 'boolean':
        return { type: 'boolean' }
      case 'select':
        return { type: 'select', options: [] }
      case 'text':
        return { type: 'text' }
      case 'number':
        return { type: 'number' }
      default:
        return undefined
    }
  }
  if (typeof raw === 'object' && 'type' in raw) {
    const ctrl = raw as Record<string, unknown>
    const type = ctrl.type as string
    if (type === 'select') {
      return {
        type: 'select',
        options: Array.isArray(ctrl.options) === true ? (ctrl.options as string[]) : [],
      }
    }
    return raw as ArgTypeControl
  }
  return undefined
}

/** Parse a raw argTypes object into normalized ArgType records */
const parseArgTypes = (raw: Record<string, unknown> | undefined): Record<string, ArgType> => {
  if (raw === undefined) return {}
  const result: Record<string, ArgType> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    let control = normalizeControl(entry.control)
    if (control === undefined) continue
    // If control is 'select' but options are on the entry level (Storybook shorthand)
    if (
      control.type === 'select' &&
      control.options.length === 0 &&
      Array.isArray(entry.options) === true
    ) {
      control = { type: 'select', options: entry.options as string[] }
    }
    result[key] = {
      description: typeof entry.description === 'string' ? entry.description : undefined,
      control,
      ...(entry.if !== undefined ? { if: entry.if as { arg: string } } : {}),
    }
  }
  return result
}

/** Parse the default export (Meta) from a CSF module */
const parseMeta = (defaultExport: unknown): StoryMeta | undefined => {
  if (typeof defaultExport !== 'object' || defaultExport === null) return undefined
  const meta = defaultExport as Record<string, unknown>
  const title = meta.title
  if (typeof title !== 'string') return undefined
  return {
    title,
    args: (typeof meta.args === 'object' && meta.args !== null ? meta.args : {}) as Record<
      string,
      unknown
    >,
    argTypes: parseArgTypes(meta.argTypes as Record<string, unknown> | undefined),
  }
}

/** Check if an export looks like a StoryObj (has a render function or args) */
const isStoryExport = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj.render === 'function' || obj.args !== undefined
}

/** Parse a complete CSF module into structured data */
export const parseStoryModule = ({
  exports,
  filePath,
}: {
  readonly exports: RawStoryModuleExports
  readonly filePath: string
}): ParsedStoryModule | undefined => {
  const meta = parseMeta(exports.default)
  if (meta === undefined) return undefined

  const stories: ResolvedStory[] = []
  for (const [exportName, exportValue] of Object.entries(exports)) {
    if (exportName === 'default') continue
    if (isStoryExport(exportValue) === false) continue

    const story = exportValue as Record<string, unknown>
    const render = story.render as ((args: Record<string, unknown>) => ReactElement) | undefined
    if (render === undefined) continue

    const storyArgs = (
      typeof story.args === 'object' && story.args !== null ? story.args : {}
    ) as Record<string, unknown>

    const mergedArgs = { ...meta.args, ...storyArgs }
    const mergedArgTypes = {
      ...meta.argTypes,
      ...parseArgTypes(story.argTypes as Record<string, unknown> | undefined),
    }

    stories.push({
      name: exportName,
      title: meta.title,
      id: `${meta.title}/${exportName}`,
      render,
      args: mergedArgs,
      argTypes: mergedArgTypes,
      filePath,
    })
  }

  return { meta, stories, filePath }
}

/** Find a story by its ID (title/name), supporting prefix matching */
export const findStory = ({
  modules,
  query,
}: {
  readonly modules: readonly ParsedStoryModule[]
  readonly query: string
}): ResolvedStory | undefined => {
  const normalized = query.toLowerCase()

  // Exact match first
  for (const mod of modules) {
    for (const story of mod.stories) {
      if (story.id.toLowerCase() === normalized) return story
    }
  }

  // Prefix match (title matches, return first story)
  for (const mod of modules) {
    if (mod.meta.title.toLowerCase() === normalized && mod.stories.length > 0) {
      return mod.stories[0]
    }
  }

  // Substring match
  for (const mod of modules) {
    for (const story of mod.stories) {
      if (story.id.toLowerCase().includes(normalized) === true) return story
    }
  }

  return undefined
}

/** Parse --arg key=value pairs into an override object */
export const parseArgOverrides = (pairs: readonly string[]): Record<string, unknown> => {
  const result: Record<string, unknown> = {}
  for (const pair of pairs) {
    const eqIndex = pair.indexOf('=')
    if (eqIndex === -1) {
      result[pair] = true
      continue
    }
    const key = pair.slice(0, eqIndex)
    const rawValue = pair.slice(eqIndex + 1)

    if (rawValue === 'true') result[key] = true
    else if (rawValue === 'false') result[key] = false
    else if (Number.isNaN(Number(rawValue)) === false && rawValue !== '')
      result[key] = Number(rawValue)
    else result[key] = rawValue
  }
  return result
}
