import type { TimelineEvent } from '@overeng/tui-react/storybook'

import type { RenderStateType, RenderActionType } from '../schema.ts'
import { statusLines, execLines, storeStatusLines } from './_megarepo-renders.ts'

/** CLI flag–derived config for story content rendering (width, timeline) */
export type RenderFlagConfig = {
  width: number
  timelineMode: string
}

const defaultFlagConfig: RenderFlagConfig = {
  width: 80,
  timelineMode: 'initial',
}

/** Creates a render state with overrides */
export const createRenderState = (
  overrides: Partial<RenderStateType & { _tag: 'Complete' }>,
): RenderStateType => ({
  _tag: 'Complete',
  storyId: 'CLI/Status/Basic/Default',
  width: 80,
  timelineMode: 'initial',
  renderedLines: [],
  ...overrides,
})

/** Creates a status render fixture with real megarepo output */
export const createStatusRender = (config: Partial<RenderFlagConfig> = {}): RenderStateType => {
  const c = { ...defaultFlagConfig, ...config }
  return createRenderState({
    storyId: 'CLI/Status/Basic/Default',
    renderedLines: statusLines,
    width: c.width,
    timelineMode: c.timelineMode,
  })
}

/** Creates an exec render fixture with real megarepo output */
export const createExecRender = (config: Partial<RenderFlagConfig> = {}): RenderStateType => {
  const c = { ...defaultFlagConfig, timelineMode: 'final', ...config }
  return createRenderState({
    storyId: 'CLI/Exec/Running/RunningVerboseParallel',
    renderedLines: execLines,
    width: c.width,
    timelineMode: c.timelineMode,
  })
}

/** Creates a store status render fixture with real megarepo output */
export const createStoreStatusRender = (
  config: Partial<RenderFlagConfig> = {},
): RenderStateType => {
  const c = { ...defaultFlagConfig, width: 100, ...config }
  return createRenderState({
    storyId: 'CLI/Store/Status/MixedIssues',
    renderedLines: storeStatusLines,
    width: c.width,
    timelineMode: c.timelineMode,
  })
}

/** Creates a rendering-in-progress fixture */
export const createRenderingState = (config: Partial<RenderFlagConfig> = {}): RenderStateType => {
  const c = { ...defaultFlagConfig, timelineMode: 'final', ...config }
  return {
    _tag: 'Rendering',
    storyId: 'CLI/Sync/Fetch/FetchResults',
    width: c.width,
    timelineMode: c.timelineMode,
  }
}

/** Creates an error fixture */
export const createErrorState = (): RenderStateType => ({
  _tag: 'Error',
  storyId: 'CLI/NonExistent/Missing',
  message: 'Story not found: "CLI/NonExistent/Missing"',
})

/** Creates a timeline from rendering to complete */
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
          renderedLines: statusLines,
          width: c.width,
          timelineMode: c.timelineMode,
        }),
      },
    },
  ]
}
