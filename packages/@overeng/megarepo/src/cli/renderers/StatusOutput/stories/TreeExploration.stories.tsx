/**
 * Tree Rendering Exploration V2
 *
 * Exploring highlight variants for `mr status` with workspace as root node.
 * Fixed on T1 (full tree from root). 10 highlight variants exploring different
 * visual treatments for indicating the current location in the tree.
 *
 * Variant dimensions:
 * - H (Highlighting): How current location is visually indicated
 * - Location: Which node is "current" (root, top-member, nested-member, none)
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

type HighlightVariant = 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7' | 'H8' | 'H9' | 'H10'
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

/** Role of a node relative to the current location */
type HighlightRole = 'current' | 'ancestor' | undefined

/** Resolved styles for a highlight variant + role */
interface HighlightStyle {
  readonly nameColor?: import('@overeng/tui-core').Color | undefined
  readonly nameBold: boolean
  readonly nameDim: boolean
  readonly nameUnderline: boolean
  readonly nameItalic: boolean
  readonly bgColor?: import('@overeng/tui-core').Color | undefined
  readonly extendBg: boolean
  readonly checkColor?: import('@overeng/tui-core').Color | undefined
  readonly marker?: string | undefined
  readonly dimNonCurrent: boolean
}

const defaultStyle: HighlightStyle = {
  nameBold: true,
  nameDim: false,
  nameUnderline: false,
  nameItalic: false,
  extendBg: false,
  dimNonCurrent: false,
}

/**
 * H1:  No highlighting at all
 * H2:  Cyan name + dark bg for current, cyan name for ancestor
 * H3:  Cyan name + dark bg for current only (no ancestor)
 * H4:  Dim everything except current (spotlight)
 * H5:  Underline current, dim ancestor
 * H6:  Arrow marker "▸ " before current name
 * H7:  Bold white on blue bg for current, italic cyan for ancestor
 * H8:  Green current name + green bg tint, ancestor gets subtle green
 * H9:  Inverse-ish: bright white on ansi256:24 (dark blue) for current, dim others
 * H10: Minimal — just italic current name, nothing else
 */
const resolveStyle = ({
  variant,
  role,
}: {
  variant: HighlightVariant
  role: HighlightRole
}): HighlightStyle => {
  if (role === undefined) {
    // Non-highlighted nodes: some variants dim them
    if (variant === 'H4') return { ...defaultStyle, nameDim: true, dimNonCurrent: true }
    if (variant === 'H9') return { ...defaultStyle, nameDim: true, dimNonCurrent: true }
    return defaultStyle
  }

  switch (variant) {
    case 'H1':
      return defaultStyle

    case 'H2':
      return role === 'current'
        ? { ...defaultStyle, nameColor: 'cyan', bgColor: { ansi256: 236 }, extendBg: true }
        : { ...defaultStyle, nameColor: 'cyan' }

    case 'H3':
      return role === 'current'
        ? { ...defaultStyle, nameColor: 'cyan', bgColor: { ansi256: 236 }, extendBg: true }
        : defaultStyle

    case 'H4':
      return role === 'current'
        ? { ...defaultStyle, nameColor: 'white' }
        : { ...defaultStyle, nameDim: true, dimNonCurrent: true }

    case 'H5':
      return role === 'current'
        ? { ...defaultStyle, nameUnderline: true, nameColor: 'cyan' }
        : { ...defaultStyle, nameDim: true }

    case 'H6':
      return role === 'current'
        ? { ...defaultStyle, nameColor: 'cyan', marker: '▸ ' }
        : role === 'ancestor'
          ? { ...defaultStyle, nameColor: 'cyan' }
          : defaultStyle

    case 'H7':
      return role === 'current'
        ? {
            ...defaultStyle,
            nameColor: 'white',
            bgColor: { ansi256: 25 },
            extendBg: true,
          }
        : { ...defaultStyle, nameColor: 'cyan', nameItalic: true }

    case 'H8':
      return role === 'current'
        ? {
            ...defaultStyle,
            nameColor: 'greenBright',
            bgColor: { ansi256: 22 },
            extendBg: true,
          }
        : { ...defaultStyle, nameColor: 'green' }

    case 'H9':
      return role === 'current'
        ? {
            ...defaultStyle,
            nameColor: 'whiteBright',
            bgColor: { ansi256: 24 },
            extendBg: true,
            dimNonCurrent: true,
          }
        : { ...defaultStyle, nameDim: true, dimNonCurrent: true }

    case 'H10':
      return role === 'current'
        ? { ...defaultStyle, nameItalic: true, nameColor: 'cyan' }
        : defaultStyle
  }
}

const getRole = ({
  location,
  memberName,
  parentName,
  hasAncestor,
}: {
  location: LocationVariant
  memberName: string
  parentName?: string | undefined
  hasAncestor: boolean
}): HighlightRole => {
  if (location === 'none' || location === 'root') return undefined
  if (location === 'top-member') {
    if (memberName === 'dev-tools') return 'current'
    return undefined
  }
  if (location === 'nested-member') {
    if (memberName === 'ui-kit' && parentName === 'dev-tools') return 'current'
    if (hasAncestor === true && memberName === 'dev-tools') return 'ancestor'
  }
  return undefined
}

/** Whether the variant supports ancestor highlighting */
const hasAncestorSupport = (variant: HighlightVariant): boolean =>
  variant === 'H2' || variant === 'H6' || variant === 'H7' || variant === 'H8'

const MemberInfo = ({
  m,
  prefix = '',
  style,
}: {
  m: MemberStatus
  prefix?: string
  style: HighlightStyle
}) => {
  const dimAll =
    style.dimNonCurrent === true && style.bgColor === undefined && style.nameColor === undefined

  return (
    <Box flexDirection="row" backgroundColor={style.bgColor} extendBackground={style.extendBg}>
      <Text dim={dimAll}>{prefix}</Text>
      <Text color={style.checkColor ?? (dimAll === true ? undefined : 'green')} dim={dimAll}>
        {check}{' '}
      </Text>
      {style.marker !== undefined && <Text color={style.nameColor}>{style.marker}</Text>}
      <Text
        bold={style.nameBold}
        dim={style.nameDim}
        italic={style.nameItalic}
        underline={style.nameUnderline}
        color={style.nameColor}
      >
        {m.name}
      </Text>
      <Text dim={dimAll}> </Text>
      {m.gitStatus !== undefined && (
        <>
          <Text
            color={
              dimAll === true ? undefined : m.gitStatus.branch === 'main' ? 'green' : 'magenta'
            }
            dim={dimAll}
          >
            {m.gitStatus.branch}
          </Text>
          <Text dim>@{m.gitStatus.shortRev}</Text>
        </>
      )}
      {m.gitStatus?.isDirty === true && (
        <>
          <Text dim={dimAll}> </Text>
          <Text color={dimAll === true ? undefined : 'yellow'} dim={dimAll}>
            {dirty}
          </Text>
        </>
      )}
      {m.gitStatus?.hasUnpushed === true && (
        <>
          <Text dim={dimAll}> </Text>
          <Text color={dimAll === true ? undefined : 'red'} dim={dimAll}>
            {ahead}
          </Text>
        </>
      )}
      {m.lockInfo?.pinned === true && (
        <>
          <Text dim={dimAll}> </Text>
          <Text color={dimAll === true ? undefined : 'yellow'} dim={dimAll}>
            pinned
          </Text>
        </>
      )}
      {m.isMegarepo === true && (
        <>
          <Text dim={dimAll}> </Text>
          <Text color={dimAll === true ? undefined : 'cyan'} dim={dimAll}>
            [megarepo]
          </Text>
        </>
      )}
    </Box>
  )
}

const RootName = ({
  variant,
  location,
}: {
  variant: HighlightVariant
  location: LocationVariant
}) => {
  const isRootCurrent = location === 'root'
  const isAncestor =
    hasAncestorSupport(variant) === true && location !== 'none' && location !== 'root'
  const role: HighlightRole =
    isRootCurrent === true ? 'current' : isAncestor === true ? 'ancestor' : undefined
  const style = resolveStyle({ variant, role })
  const dimAll = style.dimNonCurrent === true && role === undefined

  return (
    <Box flexDirection="row" backgroundColor={style.bgColor} extendBackground={style.extendBg}>
      {style.marker !== undefined && <Text color={style.nameColor}>{style.marker}</Text>}
      <Text
        bold={style.nameBold || !dimAll}
        dim={dimAll || style.nameDim}
        italic={style.nameItalic}
        underline={style.nameUnderline}
        color={style.nameColor}
      >
        dev-workspace
      </Text>
    </Box>
  )
}

// =============================================================================
// Tree with highlight variant
// =============================================================================

/**
 * To pass parent context to nested renderItem calls, we track parent→children
 * mapping and look up the parent name by checking which member owns this nested item.
 */
const parentOf = (name: string): string | undefined => {
  for (const m of members) {
    if (m.nestedMembers?.some((n) => n.name === name) === true) return m.name
  }
  return undefined
}

const HighlightedTree = ({
  variant,
  location,
}: {
  variant: HighlightVariant
  location: LocationVariant
}) => {
  const ancestor = hasAncestorSupport(variant)

  return (
    <Box>
      <RootName variant={variant} location={location} />
      <Tree<MemberStatus>
        items={members}
        getChildren={(m) =>
          m.nestedMembers !== undefined && m.nestedMembers.length > 0 ? m.nestedMembers : undefined
        }
        renderItem={(m, { prefix, depth }) => {
          const parent = depth > 0 ? parentOf(m.name) : undefined
          const role = getRole({
            location,
            memberName: m.name,
            parentName: parent,
            hasAncestor: ancestor,
          })
          return <MemberInfo m={m} prefix={prefix} style={resolveStyle({ variant, role })} />
        }}
      />
    </Box>
  )
}

// =============================================================================
// Exploration App — state-driven so Storybook controls trigger re-renders
// =============================================================================

interface ExplorationState {
  readonly highlightVariant: HighlightVariant
  readonly location: LocationVariant
}

const ExplorationApp = createTuiApp({
  stateSchema: Schema.Struct({
    highlightVariant: Schema.Literal('H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'),
    location: Schema.Literal('root', 'top-member', 'nested-member', 'none'),
  }),
  actionSchema: Schema.Never,
  initial: {
    highlightVariant: 'H2' as HighlightVariant,
    location: 'nested-member' as LocationVariant,
  },
  reducer: ({ state }) => state,
})

const VARIANT_DESCRIPTIONS: Record<HighlightVariant, string> = {
  H1: 'No highlighting',
  H2: 'Cyan name + dark bg (current), cyan name (ancestor)',
  H3: 'Cyan name + dark bg (current only, no ancestor)',
  H4: 'Spotlight — dim everything except current',
  H5: 'Underline current (cyan), dim ancestor',
  H6: 'Arrow marker "▸" before current, cyan ancestor',
  H7: 'White on blue bg (current), italic cyan (ancestor)',
  H8: 'Green tint bg (current), subtle green (ancestor)',
  H9: 'White on dark blue (current), dim all others',
  H10: 'Minimal — just italic cyan name for current',
}

const ExplorationView = ({ stateAtom }: { stateAtom: Atom.Atom<ExplorationState> }) => {
  const state = useTuiAtomValue(stateAtom)

  return (
    <Box>
      <Box>
        <Text bold dim>
          {'─── '}
          {state.highlightVariant}: {VARIANT_DESCRIPTIONS[state.highlightVariant]}{' '}
          {'─'.repeat(Math.max(0, 60 - VARIANT_DESCRIPTIONS[state.highlightVariant].length))}
        </Text>
      </Box>
      <Text> </Text>
      <HighlightedTree variant={state.highlightVariant} location={state.location} />
      <Text> </Text>
      <Text dim>5 direct · 3 nested · 8/8 synced</Text>
    </Box>
  )
}

const ALL_VARIANTS: HighlightVariant[] = [
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'H7',
  'H8',
  'H9',
  'H10',
]

const GalleryView = ({ stateAtom }: { stateAtom: Atom.Atom<ExplorationState> }) => {
  const state = useTuiAtomValue(stateAtom)

  return (
    <Box>
      {ALL_VARIANTS.map((v) => (
        <React.Fragment key={v}>
          <Text bold color="cyan">
            {v}: {VARIANT_DESCRIPTIONS[v]}
          </Text>
          <HighlightedTree variant={v} location={state.location} />
          <Text dim>5 direct · 3 nested · 8/8 synced</Text>
          <Text> </Text>
        </React.Fragment>
      ))}
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
  highlightVariant: HighlightVariant
  location: LocationVariant
}
type Story = StoryObj<StoryArgs>

const defaultArgs: StoryArgs = {
  height: 600,
  highlightVariant: 'H2',
  location: 'nested-member',
}

const defaultArgTypes = {
  height: { control: { type: 'range' as const, min: 300, max: 1000, step: 50 } },
  highlightVariant: {
    description: 'Current location highlighting',
    control: { type: 'inline-radio' as const },
    options: ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'],
  },
  location: {
    description: 'Simulated pwd location',
    control: { type: 'inline-radio' as const },
    options: ['none', 'root', 'top-member', 'nested-member'],
  },
}

/** Interactive single-variant picker */
export const Exploration: Story = {
  args: defaultArgs,
  argTypes: defaultArgTypes,
  render: (args) => (
    <TuiStoryPreview
      View={ExplorationView}
      app={ExplorationApp}
      initialState={{
        highlightVariant: args.highlightVariant,
        location: args.location,
      }}
      height={args.height}
      tabs={ALL_OUTPUT_TABS}
      command="mr status --all"
    />
  ),
}

/** Gallery of all 10 highlight variants */
export const Gallery: Story = {
  args: { ...defaultArgs, height: 2000 },
  argTypes: {
    ...defaultArgTypes,
    height: { control: { type: 'range' as const, min: 300, max: 3000, step: 50 } },
  },
  render: (args) => (
    <TuiStoryPreview
      View={GalleryView}
      app={ExplorationApp}
      initialState={{
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
