import type { InspectStateType } from '../schema.ts'

export const createInspectState = (overrides?: Partial<InspectStateType>): InspectStateType => ({
  id: 'CLI/Exec/Running/RunningVerboseParallel',
  title: 'CLI/Exec/Running',
  name: 'RunningVerboseParallel',
  filePath: 'packages/@overeng/megarepo/src/cli/renderers/ExecOutput/stories/Running.stories.tsx',
  args: [],
  hasTimeline: false,
  timelineEventCount: 0,
  ...overrides,
})

export const createWithArgsState = (): InspectStateType =>
  createInspectState({
    args: [
      {
        name: 'height',
        controlType: 'range',
        description: 'Terminal height in pixels',
        defaultValue: '400',
      },
      {
        name: 'interactive',
        controlType: 'boolean',
        description: 'Enable animated timeline playback',
        defaultValue: 'false',
      },
      {
        name: 'playbackSpeed',
        controlType: 'range',
        description: 'Playback speed multiplier',
        defaultValue: '1',
        conditional: 'interactive',
      },
      {
        name: 'verbose',
        controlType: 'boolean',
        description: '--verbose: show detailed information',
        defaultValue: 'true',
      },
      {
        name: 'mode',
        controlType: 'select',
        description: '--mode flag',
        defaultValue: '"parallel"',
        options: ['parallel', 'sequential'],
      },
      {
        name: 'member',
        controlType: 'text',
        description: '--member / -m flag',
        defaultValue: '""',
      },
    ],
    hasTimeline: true,
    timelineEventCount: 8,
  })

export const createSimpleState = (): InspectStateType =>
  createInspectState({
    id: 'CLI/Status/Basic/Default',
    title: 'CLI/Status/Basic',
    name: 'Default',
    filePath: 'packages/@overeng/megarepo/src/cli/renderers/StatusOutput/stories/Basic.stories.tsx',
    args: [
      {
        name: 'height',
        controlType: 'range',
        description: 'Terminal height in pixels',
        defaultValue: '400',
      },
      {
        name: 'all',
        controlType: 'boolean',
        description: '--all: include nested megarepos',
        defaultValue: 'false',
      },
      {
        name: 'cwd',
        controlType: 'select',
        description: 'Simulated working directory',
        options: ['(root)', 'core-lib', 'dev-tools'],
      },
    ],
    hasTimeline: false,
    timelineEventCount: 0,
  })

export const createNoArgsState = (): InspectStateType =>
  createInspectState({
    id: 'Components/StatusIcon/SuccessCheck',
    title: 'Components/StatusIcon',
    name: 'SuccessCheck',
    filePath: 'packages/@overeng/megarepo/src/cli/components/StatusIcon.stories.tsx',
    args: [],
    hasTimeline: false,
    timelineEventCount: 0,
  })
