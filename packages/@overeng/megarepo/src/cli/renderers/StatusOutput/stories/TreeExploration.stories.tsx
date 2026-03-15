/**
 * Tree Rendering Exploration V1
 *
 * Exploring tree layout variants for `mr status` with workspace as root node.
 *
 * Variant dimensions:
 * - T (Tree structure): How workspace root connects to members
 * - H (Highlighting): How current location is indicated
 *
 * Still exploring:
 * - T1 vs T2 vs T3 (tree structure)
 * - H1 vs H2 vs H3 (location highlighting)
 */

import type { Atom } from '@effect-atom/atom'
import type { Meta, StoryObj } from '@storybook/react'
import { Schema } from 'effect'
import React from 'react'

import { Box, Text, Tree, createTuiApp, unicodeSymbols, useTuiAtomValue } from '@overeng/tui-react'
import { ALL_OUTPUT_TABS, TuiStoryPreview } from '@overeng/tui-react/storybook'

import { StatusApp } from '../mod.ts'
import type { MemberStatus } from '../schema.ts'
import { StatusView } from '../view.tsx'

// =============================================================================
// Variant Types
// =============================================================================

type TreeVariant = 'T1' | 'T2' | 'T3'
type HighlightVariant = 'H1' | 'H2' | 'H3'
type LocationVariant = 'root' | 'top-member' | 'nested-member' | 'none'

// =============================================================================
// Shared fixture data
// =============================================================================

const nestedMembers: MemberStatus[] = [
  {
    name: 'cli-framework',
    exists: true,
    symlinkExists: true,
    source: 'local',
    isLocal: true,
    lockInfo: undefined,
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: false,
      branch: 'main',
      shortRev: 'ghi7890',
    },
  },
  {
    name: 'ui-kit',
    exists: true,
    symlinkExists: true,
    source: 'local',
    isLocal: true,
    lockInfo: undefined,
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: true,
      changesCount: 2,
      hasUnpushed: false,
      branch: 'feature',
      shortRev: 'fed9876',
    },
  },
]

const members: MemberStatus[] = [
  {
    name: 'core-lib',
    exists: true,
    symlinkExists: true,
    source: 'alice/core-lib',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'abc1234def', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: false,
      branch: 'main',
      shortRev: 'abc1234',
    },
  },
  {
    name: 'dev-tools',
    exists: true,
    symlinkExists: true,
    source: 'acme-org/dev-tools',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'def5678abc', pinned: true },
    isMegarepo: true,
    nestedMembers,
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: true,
      branch: 'main',
      shortRev: 'def5678',
    },
  },
  {
    name: 'app-platform',
    exists: true,
    symlinkExists: true,
    source: 'acme-org/app-platform',
    isLocal: false,
    lockInfo: { ref: 'dev', commit: '9876543fed', pinned: false },
    isMegarepo: true,
    nestedMembers: [
      {
        name: 'examples',
        exists: true,
        symlinkExists: true,
        source: 'local',
        isLocal: true,
        lockInfo: undefined,
        isMegarepo: false,
        nestedMembers: undefined,
        gitStatus: {
          isDirty: false,
          changesCount: 0,
          hasUnpushed: false,
          branch: 'dev',
          shortRev: 'aaa1111',
        },
      },
    ],
    gitStatus: {
      isDirty: true,
      changesCount: 5,
      hasUnpushed: false,
      branch: 'dev',
      shortRev: '9876543',
    },
  },
  {
    name: 'dotfiles',
    exists: true,
    symlinkExists: true,
    source: 'alice/dotfiles',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'bbb2222ccc', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: false,
      branch: 'main',
      shortRev: 'bbb2222',
    },
  },
  {
    name: 'homepage',
    exists: true,
    symlinkExists: true,
    source: 'alice/homepage',
    isLocal: false,
    lockInfo: { ref: 'main', commit: 'ccc3333ddd', pinned: false },
    isMegarepo: false,
    nestedMembers: undefined,
    gitStatus: {
      isDirty: false,
      changesCount: 0,
      hasUnpushed: true,
      branch: 'main',
      shortRev: 'ccc3333',
    },
  },
]

// =============================================================================
// Symbols
// =============================================================================

const {
  status: { check, dirty },
  arrows: { up: ahead },
} = unicodeSymbols

// =============================================================================
// Rendering helpers
// =============================================================================

const MemberInfo = ({
  m,
  prefix = '',
  highlight,
}: {
  m: MemberStatus
  prefix?: string
  highlight?: 'current' | 'ancestor' | undefined
}) => {
  const bgColor = highlight === 'current' ? { ansi256: 236 } : undefined
  const nameColor = highlight === 'current' ? 'cyan' : highlight === 'ancestor' ? 'cyan' : undefined

  return (
    <Box flexDirection="row" backgroundColor={bgColor} extendBackground={highlight === 'current'}>
      <Text>{prefix}</Text>
      <Text color="green">{check} </Text>
      <Text bold color={nameColor}>
        {m.name}
      </Text>
      <Text> </Text>
      {m.gitStatus !== undefined && (
        <>
          <Text color={m.gitStatus.branch === 'main' ? 'green' : 'magenta'}>
            {m.gitStatus.branch}
          </Text>
          <Text dim>@{m.gitStatus.shortRev}</Text>
        </>
      )}
      {m.gitStatus?.isDirty === true && (
        <>
          <Text> </Text>
          <Text color="yellow">{dirty}</Text>
        </>
      )}
      {m.gitStatus?.hasUnpushed === true && (
        <>
          <Text> </Text>
          <Text color="red">{ahead}</Text>
        </>
      )}
      {m.lockInfo?.pinned === true && (
        <>
          <Text> </Text>
          <Text color="yellow">pinned</Text>
        </>
      )}
      {m.isMegarepo === true && (
        <>
          <Text> </Text>
          <Text color="cyan">[megarepo]</Text>
        </>
      )}
    </Box>
  )
}

const getHighlight = (
  highlight: HighlightVariant,
  location: LocationVariant,
  memberName: string,
  parentName?: string,
): 'current' | 'ancestor' | undefined => {
  if (highlight === 'H1') return undefined
  if (location === 'none' || location === 'root') return undefined

  if (location === 'top-member') {
    if (memberName === 'dev-tools') return 'current'
    return undefined
  }

  if (location === 'nested-member') {
    if (memberName === 'ui-kit' && parentName === 'dev-tools') return 'current'
    if (highlight === 'H2' && memberName === 'dev-tools') return 'ancestor'
  }
  return undefined
}

const RootName = ({
  highlight,
  location,
}: {
  highlight: HighlightVariant
  location: LocationVariant
}) => {
  const isRootCurrent = location === 'root'
  const isAncestor = highlight === 'H2' && location !== 'none' && location !== 'root'

  return (
    <Box
      flexDirection="row"
      backgroundColor={isRootCurrent === true && highlight !== 'H1' ? { ansi256: 236 } : undefined}
      extendBackground={isRootCurrent === true && highlight !== 'H1'}
    >
      <Text
        bold
        color={
          (isRootCurrent === true && highlight !== 'H1') || isAncestor === true ? 'cyan' : undefined
        }
      >
        dev-workspace
      </Text>
    </Box>
  )
}

// =============================================================================
// T1: Full tree from root — all members are children of workspace
// =============================================================================

const TreeT1 = ({
  highlight,
  location,
}: {
  highlight: HighlightVariant
  location: LocationVariant
}) => (
  <Box>
    <RootName highlight={highlight} location={location} />
    <Tree<MemberStatus>
      items={members}
      getChildren={(m) =>
        m.nestedMembers !== undefined && m.nestedMembers.length > 0 ? m.nestedMembers : undefined
      }
      renderItem={(m, { prefix }) => (
        <MemberInfo m={m} prefix={prefix} highlight={getHighlight(highlight, location, m.name)} />
      )}
    />
  </Box>
)

// =============================================================================
// T2: Full tree + blank continuation lines between megarepo groups
// =============================================================================

const TreeT2 = ({
  highlight,
  location,
}: {
  highlight: HighlightVariant
  location: LocationVariant
}) => (
  <Box>
    <RootName highlight={highlight} location={location} />
    <Tree<MemberStatus>
      items={members}
      getChildren={(m) =>
        m.nestedMembers !== undefined && m.nestedMembers.length > 0 ? m.nestedMembers : undefined
      }
      renderItem={(m, { prefix }) => (
        <MemberInfo m={m} prefix={prefix} highlight={getHighlight(highlight, location, m.name)} />
      )}
      renderChildContent={(m, { continuationPrefix }) => {
        const hasChildren = m.nestedMembers !== undefined && m.nestedMembers.length > 0
        if (hasChildren === false) return null
        return <Text>{continuationPrefix}</Text>
      }}
    />
  </Box>
)

// =============================================================================
// T3: Indented — no tree chars for root level, tree only for nesting
// =============================================================================

const TreeT3 = ({
  highlight,
  location,
}: {
  highlight: HighlightVariant
  location: LocationVariant
}) => (
  <Box>
    <RootName highlight={highlight} location={location} />
    <Text> </Text>
    {members.map((m) => (
      <React.Fragment key={m.name}>
        <MemberInfo m={m} prefix={'  '} highlight={getHighlight(highlight, location, m.name)} />
        {m.nestedMembers !== undefined && m.nestedMembers.length > 0 && (
          <Box paddingLeft={2}>
            <Tree<MemberStatus>
              items={m.nestedMembers}
              renderItem={(nested, { prefix }) => (
                <MemberInfo
                  m={nested}
                  prefix={prefix}
                  highlight={getHighlight(highlight, location, nested.name, m.name)}
                />
              )}
            />
          </Box>
        )}
      </React.Fragment>
    ))}
  </Box>
)

// =============================================================================
// Exploration App — state-driven so Storybook controls trigger re-renders
// =============================================================================

interface ExplorationState {
  readonly treeVariant: TreeVariant
  readonly highlightVariant: HighlightVariant
  readonly location: LocationVariant
}

const ExplorationApp = createTuiApp({
  stateSchema: Schema.Struct({
    treeVariant: Schema.Literal('T1', 'T2', 'T3'),
    highlightVariant: Schema.Literal('H1', 'H2', 'H3'),
    location: Schema.Literal('root', 'top-member', 'nested-member', 'none'),
  }),
  actionSchema: Schema.Never,
  initial: {
    treeVariant: 'T1' as TreeVariant,
    highlightVariant: 'H2' as HighlightVariant,
    location: 'nested-member' as LocationVariant,
  },
  reducer: ({ state }) => state,
})

const ExplorationView = ({ stateAtom }: { stateAtom: Atom.Atom<ExplorationState> }) => {
  const state = useTuiAtomValue(stateAtom)
  const TreeComponent =
    state.treeVariant === 'T1' ? TreeT1 : state.treeVariant === 'T2' ? TreeT2 : TreeT3

  return (
    <Box>
      <Box>
        <Text bold dim>
          {'─── Variant Legend '}
          {'─'.repeat(50)}
        </Text>
      </Box>
      <Text dim>T1: Full tree from root (├── └── │)</Text>
      <Text dim>T2: Full tree + blank lines between megarepo groups</Text>
      <Text dim>T3: Indented list, tree chars only for nesting</Text>
      <Text dim>H1: No highlighting</Text>
      <Text dim>H2: Path highlighting (ancestor=cyan, current=cyan+bg)</Text>
      <Text dim>H3: Current-only highlighting (current=cyan+bg, no ancestor)</Text>
      <Text> </Text>
      <Box>
        <Text bold dim>
          {'─── Preview '}
          {'─'.repeat(57)}
        </Text>
      </Box>
      <Text> </Text>
      <TreeComponent highlight={state.highlightVariant} location={state.location} />
      <Text> </Text>
      <Text dim>5 direct · 3 nested · 8/8 synced</Text>
    </Box>
  )
}

const SideBySideView = ({ stateAtom }: { stateAtom: Atom.Atom<ExplorationState> }) => {
  const state = useTuiAtomValue(stateAtom)

  return (
    <Box>
      <Text bold color="cyan">
        T1: Full tree
      </Text>
      <TreeT1 highlight={state.highlightVariant} location={state.location} />
      <Text> </Text>
      <Text dim>5 direct · 3 nested · 8/8 synced</Text>
      <Text> </Text>
      <Text> </Text>
      <Text bold color="cyan">
        T2: Full tree + spacing
      </Text>
      <TreeT2 highlight={state.highlightVariant} location={state.location} />
      <Text> </Text>
      <Text dim>5 direct · 3 nested · 8/8 synced</Text>
      <Text> </Text>
      <Text> </Text>
      <Text bold color="cyan">
        T3: Indented list
      </Text>
      <TreeT3 highlight={state.highlightVariant} location={state.location} />
      <Text> </Text>
      <Text dim>5 direct · 3 nested · 8/8 synced</Text>
    </Box>
  )
}

// =============================================================================
// Story
// =============================================================================

export default {
  title: 'CLI/Status/Tree Exploration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

type StoryArgs = {
  height: number
  treeVariant: TreeVariant
  highlightVariant: HighlightVariant
  location: LocationVariant
}
type Story = StoryObj<StoryArgs>

const defaultArgs: StoryArgs = {
  height: 600,
  treeVariant: 'T1',
  highlightVariant: 'H2',
  location: 'nested-member',
}

const defaultArgTypes = {
  height: { control: { type: 'range' as const, min: 300, max: 1000, step: 50 } },
  treeVariant: {
    description: 'Tree structure variant',
    control: { type: 'inline-radio' as const },
    options: ['T1', 'T2', 'T3'],
  },
  highlightVariant: {
    description: 'Current location highlighting',
    control: { type: 'inline-radio' as const },
    options: ['H1', 'H2', 'H3'],
  },
  location: {
    description: 'Simulated pwd location',
    control: { type: 'inline-radio' as const },
    options: ['none', 'root', 'top-member', 'nested-member'],
  },
}

/** Interactive variant picker */
export const Exploration: Story = {
  args: defaultArgs,
  argTypes: defaultArgTypes,
  render: (args) => (
    <TuiStoryPreview
      View={ExplorationView}
      app={ExplorationApp}
      initialState={{
        treeVariant: args.treeVariant,
        highlightVariant: args.highlightVariant,
        location: args.location,
      }}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status --all"
    />
  ),
}

/** Side-by-side comparison of all tree variants */
export const SideBySide: Story = {
  args: { ...defaultArgs, height: 800 },
  argTypes: defaultArgTypes,
  render: (args) => (
    <TuiStoryPreview
      View={SideBySideView}
      app={ExplorationApp}
      initialState={{
        treeVariant: args.treeVariant,
        highlightVariant: args.highlightVariant,
        location: args.location,
      }}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status --all"
    />
  ),
}

/** Current status output (baseline) for comparison */
export const CurrentBaseline: Story = {
  args: defaultArgs,
  render: () => (
    <TuiStoryPreview
      View={StatusView}
      app={StatusApp}
      initialState={{
        workspaceSyncNeeded: false,
        lockSyncNeeded: false,
        name: 'dev-workspace',
        root: '/Users/dev/.megarepo/github.com/alice/dev-workspace/refs/heads/main',
        syncNeeded: false,
        syncReasons: [],
        all: true,
        members,
        currentMemberPath: ['dev-tools', 'ui-kit'],
      }}
      height={500}
      tabs={ALL_OUTPUT_TABS}
      command="mr status --all"
      cwd="~/dev-workspace/repos/dev-tools/repos/ui-kit"
    />
  ),
}
