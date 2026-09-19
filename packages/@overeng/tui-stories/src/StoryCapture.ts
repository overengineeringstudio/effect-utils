/**
 * Capture TuiStoryPreview props from story render functions.
 *
 * Story render functions may use React hooks (useMemo, useState), so they
 * can't be called outside a React reconciler context. This module wraps
 * the render call in a lightweight React component, executes it through
 * renderToString (which provides a reconciler), and intercepts the
 * TuiStoryPreview element props before it mounts.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import type { Schema } from 'effect'
import type { Atom } from 'effect/unstable/reactivity'
import type { createElement, ReactElement, ComponentType } from 'react'

// Import only the type — the runtime TuiStoryPreview import pulls in xterm.js
// which creates open handles that prevent process exit in Node/Bun.
import type { renderToString } from '@overeng/tui-react'
import type { TimelineEvent } from '@overeng/tui-react/storybook'

import type { ResolvedStory } from './StoryModule.ts'
const storyCaptureSymbol = Symbol.for('@overeng/tui-react/TuiStoryPreview.capture')

type StoryRuntime = {
  readonly createElement: typeof createElement
  readonly renderToString: typeof renderToString
}

const loadStoryRuntime = async (filePath: string): Promise<StoryRuntime> => {
  const storyRequire = createRequire(filePath)
  const [react, tuiReact] = await Promise.all([
    // oxlint-disable-next-line import/no-dynamic-require -- story hooks require the React instance selected by the story package
    import(pathToFileURL(storyRequire.resolve('react')).href),
    // oxlint-disable-next-line import/no-dynamic-require -- the reconciler must use the story package's React peer instance
    import(pathToFileURL(storyRequire.resolve('@overeng/tui-react')).href),
  ])
  return {
    createElement: react.createElement,
    renderToString: tuiReact.renderToString,
  }
}

// =============================================================================
// Types
// =============================================================================

/** Captured props extracted from a TuiStoryPreview element */
export interface CapturedStoryProps {
  readonly app: {
    readonly config: {
      readonly stateSchema: Schema.Codec<unknown>
      readonly actionSchema: Schema.Codec<unknown>
      readonly initial: unknown
      readonly reducer: (args: { state: unknown; action: unknown }) => unknown
    }
  }
  readonly View: ComponentType<{ stateAtom: Atom.Atom<unknown> }>
  readonly initialState: unknown
  readonly timeline: readonly TimelineEvent<unknown>[]
  readonly command: string
  readonly cwd?: string | undefined
}

/** Error raised when capturing props from a story's render function fails */
export class StoryCaptureError extends Error {
  readonly _tag = 'StoryCaptureError'
  readonly storyId: string
  constructor({ storyId, message }: { readonly storyId: string; readonly message: string }) {
    super(message)
    this.storyId = storyId
  }
}

// =============================================================================
// Element Tree Walking
// =============================================================================

/**
 * Walk a React element tree to find a component with the TuiStoryPreview prop contract.
 *
 * Editor dependency views can load a separately transformed component instance, so
 * component identity and function names are not stable capture boundaries.
 */
const hasPreviewContract = (props: Record<string, unknown>): boolean =>
  'app' in props && 'View' in props && typeof props.command === 'string'

const extractPreviewProps = (element: ReactElement): CapturedStoryProps | undefined => {
  if (element === null || element === undefined) return undefined
  if (typeof element !== 'object') return undefined

  const props = (element as { props?: Record<string, unknown> }).props

  if (props === undefined) return undefined

  if (hasPreviewContract(props) === true) return extractFromProps(props)

  // Walk children recursively
  const children = props.children
  if (children !== undefined) {
    if (Array.isArray(children) === true) {
      for (const child of children) {
        if (typeof child === 'object' && child !== null) {
          const result = extractPreviewProps(child as ReactElement)
          if (result !== undefined) return result
        }
      }
    } else if (typeof children === 'object') {
      return extractPreviewProps(children as ReactElement)
    }
  }

  return undefined
}

const describeElement = (element: ReactElement): string => {
  const type = element.type
  const typeName =
    typeof type === 'string'
      ? type
      : typeof type === 'function'
        ? type.name || '<anonymous>'
        : typeof type === 'object' && type !== null
          ? String(Reflect.get(type, 'displayName') ?? Reflect.get(type, 'name') ?? '<object>')
          : String(type)
  const props = element.props as Record<string, unknown>
  return `type=${typeName}; props=[${Object.keys(props).toSorted().join(', ')}]`
}

/** Extract CapturedStoryProps from raw TuiStoryPreview props */
const extractFromProps = (props: Record<string, unknown>): CapturedStoryProps => ({
  app: props.app as CapturedStoryProps['app'],
  View: props.View as CapturedStoryProps['View'],
  initialState: props.initialState,
  timeline: (props.timeline as readonly TimelineEvent<unknown>[]) ?? [],
  command: (props.command as string) ?? '',
  cwd: props.cwd as string | undefined,
})

// =============================================================================
// Capture
// =============================================================================

/**
 * Capture TuiStoryPreview props from a story's render function.
 *
 * Always uses the React reconciler approach (via renderToString) to ensure
 * hooks like useMemo work correctly. The render call is wrapped in a
 * lightweight component that intercepts the element tree.
 */
export const captureStoryProps = async ({
  story,
  argOverrides,
}: {
  readonly story: ResolvedStory
  readonly argOverrides?: Record<string, unknown> | undefined
}): Promise<CapturedStoryProps> => {
  const mergedArgs = { ...story.args, ...argOverrides }
  const storyRuntime = await loadStoryRuntime(story.filePath)

  let captured: CapturedStoryProps | undefined
  let observedElement = '<render did not return an element>'
  const CaptureWrapper = (): ReactElement | null => {
    const element = story.render(mergedArgs)
    observedElement = describeElement(element)
    captured = extractPreviewProps(element)
    return captured === undefined ? element : null
  }

  const previousCapture = Reflect.get(globalThis, storyCaptureSymbol)
  Reflect.set(globalThis, storyCaptureSymbol, (props: Record<string, unknown>) => {
    captured = extractFromProps(props)
  })
  const renderPromise = (() => {
    try {
      return storyRuntime.renderToString({
        element: storyRuntime.createElement(CaptureWrapper),
      })
    } finally {
      if (previousCapture === undefined) {
        Reflect.deleteProperty(globalThis, storyCaptureSymbol)
      } else {
        Reflect.set(globalThis, storyCaptureSymbol, previousCapture)
      }
    }
  })()
  await renderPromise

  if (captured === undefined) {
    throw new StoryCaptureError({
      storyId: story.id,
      message:
        `Could not find TuiStoryPreview element in story "${story.id}". ` +
        `The render function must return a <TuiStoryPreview> element. Observed ${observedElement}.`,
    })
  }

  return captured
}
