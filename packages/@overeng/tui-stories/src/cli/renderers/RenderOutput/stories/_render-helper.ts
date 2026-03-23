/**
 * Helper to render actual megarepo View components for realistic story fixtures.
 *
 * Uses renderToString from tui-react to produce real ANSI output from
 * megarepo's TUI components, keeping story fixtures in sync with the
 * actual CLI output.
 */

import type { Atom } from '@effect-atom/atom'
import { Registry } from '@effect-atom/atom'
import React from 'react'

import {
  renderToString,
  RenderConfigProvider,
  ciRenderConfig,
  TuiRegistryContext,
  type RenderConfig,
} from '@overeng/tui-react'

/** Render a TUI view component to lines with the given state and config */
export const renderViewToLines = async <S>({
  View,
  stateAtom,
  width = 80,
  renderConfig = ciRenderConfig,
}: {
  readonly View: React.ComponentType<{ stateAtom: Atom.Atom<S> }>
  readonly stateAtom: Atom.Atom<S>
  readonly width?: number
  readonly renderConfig?: RenderConfig
}): Promise<string[]> => {
  const registry = Registry.make()

  const viewElement = React.createElement(View, { stateAtom })
  const configElement = React.createElement(
    RenderConfigProvider,
    { config: renderConfig } as React.ComponentProps<typeof RenderConfigProvider>,
    viewElement,
  )
  const element = React.createElement(
    TuiRegistryContext.Provider,
    { value: registry },
    configElement,
  )

  const output = await renderToString({ element, options: { width } })
  return output.split('\n')
}
