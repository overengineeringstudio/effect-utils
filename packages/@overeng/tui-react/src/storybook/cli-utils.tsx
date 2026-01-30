/**
 * CLI Storybook Utilities
 *
 * Helpers for creating Storybook stories for CLI components.
 *
 * @example
 * ```tsx
 * import { createCliMeta, TerminalPreview } from '@overeng/tui-react/storybook'
 *
 * const meta = createCliMeta<MyComponentProps>(MyComponent, {
 *   title: 'CLI/MyComponent',
 *   description: 'My CLI component',
 *   defaultArgs: { prop1: 'value1' },
 * })
 *
 * export default meta
 *
 * export const Default: Story = {
 *   args: { prop1: 'value1' },
 * }
 * ```
 */

import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { RenderConfigProvider, logRenderConfig, stripAnsi } from '../effect/OutputMode.tsx'
import { renderToString } from '../renderToString.ts'
import { TuiStoryPreview } from './TuiStoryPreview.tsx'

// =============================================================================
// TerminalPreview - Simple terminal wrapper for children
// =============================================================================

export interface TerminalPreviewProps {
  /** React children to render in the terminal */
  children: React.ReactNode
  /** Terminal height in pixels (default: 400) */
  height?: number
  /** Whether to show output mode tabs (default: false for simple usage) */
  showTabs?: boolean
}

/**
 * Simple terminal preview wrapper for CLI components.
 * By default renders just the terminal without tabs (ideal for decorators).
 * Set `showTabs={true}` to show TTY/CI/Log tabs.
 *
 * @example Simple usage (no tabs):
 * ```tsx
 * <TerminalPreview>
 *   <Box><Text color="green">Success!</Text></Box>
 * </TerminalPreview>
 * ```
 *
 * @example With tabs:
 * ```tsx
 * <TerminalPreview showTabs>
 *   <Box><Text color="green">Success!</Text></Box>
 * </TerminalPreview>
 * ```
 */
export const TerminalPreview: React.FC<TerminalPreviewProps> = ({
  children,
  height = 400,
  showTabs = false,
}) => {
  return (
    <TuiStoryPreview
      height={height}
      tabs={showTabs ? ['tty', 'ci', 'log'] : ['tty']}
      defaultTab="tty"
    >
      {children}
    </TuiStoryPreview>
  )
}

// =============================================================================
// StringTerminalPreview - Plain text output preview
// =============================================================================

/** Props for children-based usage */
interface StringTerminalPreviewChildrenProps {
  /** React children to render as plain text */
  children: React.ReactNode
  /** Container height in pixels (default: 400) */
  height?: number
}

/** Props for component + props pattern (useful in Storybook) */
interface StringTerminalPreviewComponentProps<P extends object> {
  /** Component to render */
  component: React.ComponentType<P>
  /** Props to pass to the component */
  props: P
  /** Container height in pixels (default: 400) */
  height?: number
}

export type StringTerminalPreviewProps<P extends object = object> =
  | StringTerminalPreviewChildrenProps
  | StringTerminalPreviewComponentProps<P>

/** Type guard for component + props pattern */
const isComponentProps = <P extends object>(
  props: StringTerminalPreviewProps<P>,
): props is StringTerminalPreviewComponentProps<P> => {
  return 'component' in props && props.component !== undefined
}

/**
 * Plain text preview for CLI output (no colors/ANSI codes).
 * Useful for testing how output looks in non-TTY environments.
 *
 * @example Children pattern:
 * ```tsx
 * <StringTerminalPreview>
 *   <Box><Text color="green">Success!</Text></Box>
 * </StringTerminalPreview>
 * // Renders: "Success!" (without color)
 * ```
 *
 * @example Component + props pattern (for Storybook):
 * ```tsx
 * <StringTerminalPreview component={MyOutput} props={{ status: 'success' }} />
 * ```
 */
export function StringTerminalPreview<P extends object>(
  props: StringTerminalPreviewProps<P>,
): React.ReactElement {
  const [output, setOutput] = React.useState<string>('')
  const height = props.height ?? 400

  // Get the element to render
  const element = React.useMemo(() => {
    if (isComponentProps(props)) {
      const Component = props.component
      return <Component {...props.props} />
    }
    return <>{props.children}</>
  }, [props])

  React.useEffect(() => {
    const wrappedElement = (
      <RenderConfigProvider config={logRenderConfig}>{element}</RenderConfigProvider>
    )

    renderToString({ element: wrappedElement })
      .then((ansiOutput) => {
        setOutput(stripAnsi(ansiOutput))
      })
      .catch((err: Error) => {
        setOutput(`Error: ${err.message}`)
      })
  }, [element])

  return (
    <pre
      style={{
        margin: 0,
        padding: '12px',
        background: '#1e1e1e',
        color: '#d4d4d4',
        fontFamily: 'Monaco, Menlo, "DejaVu Sans Mono", Consolas, monospace',
        fontSize: '14px',
        overflow: 'auto',
        height,
        boxSizing: 'border-box',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {output}
    </pre>
  )
}

// =============================================================================
// createCliMeta - Helper for creating CLI story meta
// =============================================================================

export interface CreateCliMetaOptions<Props> {
  /** Story title in Storybook sidebar */
  title: string
  /** Optional description for the story */
  description?: string
  /** Default args for the component */
  defaultArgs?: Partial<Props>
  /** Arg types configuration */
  argTypes?: Meta<Props>['argTypes']
  /** Terminal height in pixels (default: 400) */
  terminalHeight?: number
  /** Additional decorators */
  decorators?: Meta<Props>['decorators']
  /** Additional parameters */
  parameters?: Meta<Props>['parameters']
}

/**
 * Creates a Storybook meta object for CLI components with terminal preview.
 *
 * @example
 * ```tsx
 * import { createCliMeta } from '@overeng/tui-react/storybook'
 *
 * const meta = createCliMeta<MyOutputProps>(MyOutput, {
 *   title: 'CLI/MyOutput',
 *   description: 'Output for my command',
 *   defaultArgs: { status: 'success' },
 *   argTypes: {
 *     status: { control: 'select', options: ['success', 'error'] },
 *   },
 * })
 *
 * export default meta
 * type Story = StoryObj<typeof meta>
 *
 * export const Success: Story = { args: { status: 'success' } }
 * ```
 */
export const createCliMeta = <Props extends object>(
  Component: React.ComponentType<Props>,
  options: CreateCliMetaOptions<Props>,
): Meta<Props> => {
  const { title, description, defaultArgs, argTypes, terminalHeight = 400, decorators, parameters = {} } =
    options

  const terminalDecorator = (Story: React.ComponentType) => (
    <TerminalPreview height={terminalHeight}>
      <Story />
    </TerminalPreview>
  )

  return {
    title,
    component: Component,
    args: defaultArgs as Props,
    argTypes,
    decorators: decorators
      ? [terminalDecorator, ...(Array.isArray(decorators) ? decorators : [decorators])]
      : [terminalDecorator],
    parameters: {
      layout: 'padded',
      docs: {
        description: description ? { component: description } : undefined,
      },
      ...parameters,
    },
  } as Meta<Props>
}

// =============================================================================
// Type exports
// =============================================================================

export type CliStoryMeta<Props> = Meta<Props>
export type CliStory<Props> = StoryObj<Meta<Props>>
