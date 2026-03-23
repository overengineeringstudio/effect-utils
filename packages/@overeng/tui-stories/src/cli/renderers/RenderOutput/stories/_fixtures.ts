import type { TimelineEvent } from '@overeng/tui-react/storybook'

import type { RenderStateType, RenderActionType } from '../schema.ts'

/** CLI flag–derived config passed into fixture factories */
export type RenderFlagConfig = {
  output: RenderStateType & { _tag: 'Complete' } extends { output: infer O } ? O : never
  width: number
  timelineMode: string
}

const defaultFlagConfig: RenderFlagConfig = {
  output: 'ci',
  width: 80,
  timelineMode: 'initial',
}

/** Creates a render state with overrides */
export const createRenderState = (
  overrides: Partial<RenderStateType & { _tag: 'Complete' }>,
): RenderStateType => ({
  _tag: 'Complete',
  storyId: 'CLI/Status/Basic/Default',
  output: 'ci',
  width: 80,
  timelineMode: 'initial',
  renderedLines: [],
  ...overrides,
})

/** Simulated rendered output from `mr status` */
const statusOutputLines = [
  'alice/dev-workspace@main',
  '├── ✓ core-lib main@abc1234',
  '├── ✓ dev-tools main@def5678',
  '└── * app-platform main@ghi9012',
  ' ',
  '3 members · synced 30m ago',
]

/** Simulated rendered output from `mr exec` with verbose */
const execOutputLines = [
  'Command: npm version',
  'Mode: parallel',
  'Members: core-lib, dev-tools, app-platform',
  ' ',
  'core-lib:',
  'v3.0.0',
  ' ',
  'dev-tools:',
  'v1.2.3',
  ' ',
  'app-platform:',
  'v0.5.0',
]

/** Simulated rendered output from `mr store status` */
const storeStatusLines = [
  'Store: /Users/dev/.megarepo',
  '  4 repos, 6 worktrees',
  ' ',
  'Issues:',
  '✗ github.com/acme-org/app-platform//refs/heads/dev',
  "    ref_mismatch: path says 'dev' but HEAD is 'refactor/genie-igor-ci'",
  '      fix: mr config pin <member> -c refactor/genie-igor-ci',
  '    dirty: 27 uncommitted changes',
  '      fix: cd ~/.megarepo/github.com/acme-org/app-platform//refs/heads/dev',
  ' ',
  '1 error · 0 warnings',
]

export const createStatusRender = (config: Partial<RenderFlagConfig> = {}): RenderStateType => {
  const c = { ...defaultFlagConfig, ...config }
  return createRenderState({
    storyId: 'CLI/Status/Basic/Default',
    renderedLines: statusOutputLines,
    output: c.output,
    width: c.width,
    timelineMode: c.timelineMode,
  })
}

export const createExecRender = (config: Partial<RenderFlagConfig> = {}): RenderStateType => {
  const c = { ...defaultFlagConfig, timelineMode: 'final', ...config }
  return createRenderState({
    storyId: 'CLI/Exec/Running/RunningVerboseParallel',
    renderedLines: execOutputLines,
    output: c.output,
    width: c.width,
    timelineMode: c.timelineMode,
  })
}

export const createStoreStatusRender = (
  config: Partial<RenderFlagConfig> = {},
): RenderStateType => {
  const c = { ...defaultFlagConfig, width: 100, ...config }
  return createRenderState({
    storyId: 'CLI/Store/Status/MixedIssues',
    renderedLines: storeStatusLines,
    output: c.output,
    width: c.width,
    timelineMode: c.timelineMode,
  })
}

export const createRenderingState = (config: Partial<RenderFlagConfig> = {}): RenderStateType => {
  const c = { ...defaultFlagConfig, timelineMode: 'final', ...config }
  return {
    _tag: 'Rendering',
    storyId: 'CLI/Sync/Fetch/FetchResults',
    output: c.output,
    width: c.width,
    timelineMode: c.timelineMode,
  }
}

export const createErrorState = (): RenderStateType => ({
  _tag: 'Error',
  storyId: 'CLI/NonExistent/Missing',
  message: 'Story not found: "CLI/NonExistent/Missing"',
})

export const createTimeline = (
  config: Partial<RenderFlagConfig> = {},
): TimelineEvent<RenderActionType>[] => {
  const c = { ...defaultFlagConfig, ...config }
  return [
    {
      at: 0,
      action: {
        _tag: 'SetState',
        state: {
          _tag: 'Rendering',
          storyId: 'CLI/Status/Basic/Default',
          output: c.output,
          width: c.width,
          timelineMode: c.timelineMode,
        },
      },
    },
    {
      at: 800,
      action: {
        _tag: 'SetState',
        state: createRenderState({
          storyId: 'CLI/Status/Basic/Default',
          renderedLines: statusOutputLines,
          output: c.output,
          width: c.width,
          timelineMode: c.timelineMode,
        }),
      },
    },
  ]
}
