import type { Atom } from '@effect-atom/atom'
import type { Meta, StoryObj } from '@storybook/react'
import React from 'react'

import { Box, createTuiApp, Text } from '@overeng/tui-react'
import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import type { CommandFixture, CommandFixtureId, Severity } from './_fixtures.ts'
import {
  CommandFixture as CommandFixtureSchema,
  CommandFixtureAction,
  commandFixtureIds,
  createCleanStatusFixture,
  createFixture,
} from './_fixtures.ts'

const CliOutputApp = createTuiApp({
  stateSchema: CommandFixtureSchema,
  actionSchema: CommandFixtureAction,
  initial: createCleanStatusFixture(),
  reducer: ({ state, action }) => {
    switch (action._tag) {
      case 'SetFixture':
        return action.fixture
    }
    return state
  },
})

interface CliOutputArgs {
  readonly height: number
  readonly scenario: CommandFixtureId
}

const severityStyle = (
  severity: Severity,
): {
  readonly backgroundColor: 'red' | 'yellow'
  readonly color: 'black' | 'white'
  readonly label: 'CRITICAL' | 'WARNING'
} => {
  switch (severity) {
    case 'critical':
      return { backgroundColor: 'red', color: 'white', label: 'CRITICAL' }
    case 'warning':
      return { backgroundColor: 'yellow', color: 'black', label: 'WARNING' }
  }
}

type DisplayLineKind = 'badge-critical' | 'badge-warning' | 'dim' | 'fix' | 'normal'

interface DisplayLine {
  readonly kind: DisplayLineKind
  readonly text: string
}

const statusSymbol = (status: CommandFixture['items'][number]['status']): string => {
  switch (status) {
    case 'error':
      return '↕'
    case 'modified':
      return '*'
    case 'ok':
      return '✓'
    case 'synced':
    case undefined:
      return ''
  }
}

const displayLines = (fixture: CommandFixture): readonly DisplayLine[] => [
  { kind: 'normal', text: fixture.context },
  ...fixture.problems.flatMap((problem): readonly DisplayLine[] => [
    {
      kind: problem.severity === 'critical' ? 'badge-critical' : 'badge-warning',
      text: severityStyle(problem.severity).label,
    },
    { kind: 'normal', text: `  ${problem.name} ${problem.status} ${problem.details}` },
    ...(problem.context === undefined
      ? []
      : [{ kind: 'dim' as const, text: `    ${problem.context}` }]),
    ...problem.fixes.map((fix): DisplayLine => ({ kind: 'fix', text: `    fix: ${fix}` })),
    ...(problem.skips ?? []).map(
      (skip): DisplayLine => ({ kind: 'dim', text: `    skip: ${skip}` }),
    ),
  ]),
  ...(fixture.problems.length === 0 || fixture.items.length === 0
    ? []
    : [{ kind: 'dim' as const, text: '---' }]),
  ...fixture.items.flatMap((item): readonly DisplayLine[] => [
    {
      kind: 'normal',
      text: `${item.name} ${item.ref} ${statusSymbol(item.status)} ${item.relationship ?? ''}`,
    },
    ...item.sections.flatMap((section): readonly DisplayLine[] => [
      {
        kind: 'normal',
        text: `  ${section.title}(${section.items.length + (section.more ?? 0)}):`,
      },
      ...section.items.map((detail): DisplayLine => ({ kind: 'dim', text: `    ${detail}` })),
      ...(section.more === undefined
        ? []
        : [{ kind: 'dim' as const, text: `    + ${section.more} more` }]),
    ]),
  ]),
  { kind: 'dim', text: fixture.summary },
]

const DisplayText = ({ line }: { readonly line: DisplayLine }) => {
  switch (line.kind) {
    case 'badge-critical':
      return (
        <Text bold backgroundColor="red" color="white">
          {line.text}
        </Text>
      )
    case 'badge-warning':
      return (
        <Text bold backgroundColor="yellow" color="black">
          {line.text}
        </Text>
      )
    case 'dim':
      return <Text dim>{line.text}</Text>
    case 'fix':
      return <Text color="cyan">{line.text}</Text>
    case 'normal':
      return <Text>{line.text}</Text>
  }
}

const CliOutputView = ({ fixture }: { readonly fixture: CommandFixture }) => (
  <Box flexDirection="column">
    {displayLines(fixture).map((line) => (
      <DisplayText key={line.text} line={line} />
    ))}
  </Box>
)

const StoryView =
  (
    fixture: CommandFixture,
  ): React.ComponentType<{ readonly stateAtom: Atom.Atom<CommandFixture> }> =>
  () => <CliOutputView fixture={fixture} />

const CliOutputStory = ({ height, scenario }: CliOutputArgs) => {
  const fixture = createFixture(scenario)
  return (
    <TuiStoryPreview
      app={CliOutputApp}
      View={StoryView(fixture)}
      command={fixture.command}
      initialState={fixture}
      height={height}
      tabs={ALL_OUTPUT_TABS}
    />
  )
}

const renderPreview = (opts: {
  readonly args: CliOutputArgs
  readonly scenario?: CommandFixtureId
}) => {
  const { args } = opts
  const scenario = opts.scenario ?? args.scenario
  const fixture = createFixture(scenario)
  return (
    <TuiStoryPreview
      app={CliOutputApp}
      View={StoryView(fixture)}
      command={fixture.command}
      initialState={fixture}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
    />
  )
}

export default {
  title: 'notion-md/CLI/Output',
  component: CliOutputStory,
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    height: 400,
    scenario: 'clean-status',
  },
  argTypes: {
    height: {
      description: 'Terminal height in pixels',
      control: { type: 'range', min: 200, max: 600, step: 50 },
    },
    scenario: {
      control: 'select',
      options: commandFixtureIds,
    },
  },
} satisfies Meta<typeof CliOutputStory>

type Story = StoryObj<typeof CliOutputStory>

export const Primary: Story = {
  render: (args) => renderPreview({ args }),
}

export const CleanStatus: Story = {
  args: { scenario: 'clean-status' },
  render: (args) => renderPreview({ args, scenario: 'clean-status' }),
}

export const BodyConflict: Story = {
  args: { scenario: 'body-conflict' },
  render: (args) => renderPreview({ args, scenario: 'body-conflict' }),
}

export const UnknownBlocks: Story = {
  args: { scenario: 'unknown-blocks' },
  render: (args) => renderPreview({ args, scenario: 'unknown-blocks' }),
}

export const WatchSync: Story = {
  args: { scenario: 'watch-sync' },
  render: (args) => renderPreview({ args, scenario: 'watch-sync' }),
}

export const MissingToken: Story = {
  args: { scenario: 'missing-token' },
  render: (args) => renderPreview({ args, scenario: 'missing-token' }),
}

export const AllStates: Story = {
  render: (args) => (
    <Box flexDirection="column" gap={2}>
      {commandFixtureIds.map((scenario) => {
        const fixture = createFixture(scenario)
        return (
          <Box key={scenario} flexDirection="column" gap={1}>
            <Text bold color="magenta">
              {scenario}
            </Text>
            <TuiStoryPreview
              app={CliOutputApp}
              View={StoryView(fixture)}
              command={fixture.command}
              initialState={fixture}
              height={args.height}
              tabs={ALL_OUTPUT_TABS}
            />
          </Box>
        )
      })}
    </Box>
  ),
}
