/**
 * Factory function for creating CLI component story metas
 *
 * This reduces boilerplate by handling:
 * - TTY/string render mode toggle
 * - Terminal preview setup
 * - Common argTypes
 */

import type { Meta, ArgTypes } from '@storybook/react'
import React from 'react'

import { TerminalPreview } from './TerminalPreview.tsx'
import { StringTerminalPreview } from './StringTerminalPreview.tsx'

/** Render mode for CLI stories */
export type RenderMode = 'tty' | 'string'

/** Props added by createCliMeta */
export interface CliMetaProps {
  renderMode: RenderMode
}

/** Configuration for createCliMeta */
export interface CliMetaConfig<P extends object> {
  /** Story title (e.g., 'CLI/Store/GC') */
  title: string
  /** Component description for docs */
  description?: string | undefined
  /** Default args for the component */
  defaultArgs?: Partial<P> | undefined
  /** Additional argTypes for the component */
  argTypes?: Partial<ArgTypes<P>> | undefined
  /** Terminal height in pixels (default: 400) */
  terminalHeight?: number | undefined
}

/**
 * Creates a Storybook meta configuration for CLI components
 *
 * @example
 * ```tsx
 * import { createCliMeta } from '@overeng/tui-react/storybook'
 * import { StoreGcOutput, type StoreGcOutputProps } from './StoreOutput.tsx'
 *
 * const meta = createCliMeta(StoreGcOutput, {
 *   title: 'CLI/Store/GC',
 *   description: 'Output for `mr store gc`',
 *   defaultArgs: { basePath: '/Users/dev/.megarepo', results: [], dryRun: false },
 * })
 *
 * export default meta
 * type Story = StoryObj<typeof meta>
 *
 * export const Mixed: Story = { args: { results: exampleGcResults } }
 * ```
 */
export const createCliMeta = <P extends object>(
  Component: React.ComponentType<P>,
  config: CliMetaConfig<P>,
): Meta<P & CliMetaProps> => {
  const { title, description, defaultArgs, argTypes, terminalHeight = 400 } = config

  type StoryArgs = P & CliMetaProps

  return {
    title,
    component: Component,
    parameters: {
      layout: 'fullscreen',
      ...(description && {
        docs: {
          description: {
            component: description,
          },
        },
      }),
    },
    argTypes: {
      renderMode: {
        description: 'Switch between TTY (interactive) and string (non-TTY) output',
        control: { type: 'radio' },
        options: ['tty', 'string'],
        table: { category: 'Render Mode' },
      },
      ...argTypes,
    },
    args: {
      renderMode: 'tty',
      ...defaultArgs,
    },
    render: (args: StoryArgs) => {
      const { renderMode, ...props } = args
      // TODO also support `alt-mode` via OpenTUI and `json` mode?
      if (renderMode === 'string') {
        return (
          <StringTerminalPreview
            component={Component}
            props={props as P}
            height={terminalHeight}
          />
        )
      }
      return (
        <TerminalPreview height={terminalHeight}>
          {React.createElement(Component, props as P)}
        </TerminalPreview>
      )
    },
  } as unknown as Meta<P & CliMetaProps>
}
