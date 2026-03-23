import type { ListStateType } from '../schema.ts'

export const createListState = (overrides?: Partial<ListStateType>): ListStateType => ({
  groups: [],
  skippedCount: 0,
  packagePath: 'packages/@overeng/megarepo',
  ...overrides,
})

export const componentGroups = [
  {
    title: 'Components/StatusIcon',
    stories: [
      { name: 'SuccessCheck', hasTimeline: false, argCount: 0 },
      { name: 'ErrorCross', hasTimeline: false, argCount: 0 },
      { name: 'ActiveSpinner', hasTimeline: false, argCount: 0 },
    ],
  },
  {
    title: 'Components/Summary',
    stories: [
      { name: 'AllSuccess', hasTimeline: false, argCount: 0 },
      { name: 'WithErrors', hasTimeline: false, argCount: 0 },
      { name: 'DryRunMode', hasTimeline: false, argCount: 0 },
    ],
  },
  {
    title: 'Components/TaskItem',
    stories: [
      { name: 'AllStates', hasTimeline: false, argCount: 0 },
      { name: 'SingleActive', hasTimeline: false, argCount: 0 },
    ],
  },
]

export const cliGroups = [
  {
    title: 'CLI/Status/Basic',
    stories: [
      { name: 'Default', hasTimeline: false, argCount: 3 },
      { name: 'WithErrors', hasTimeline: false, argCount: 3 },
      { name: 'EmptyWorkspace', hasTimeline: false, argCount: 3 },
    ],
  },
  {
    title: 'CLI/Exec/Running',
    stories: [
      { name: 'RunningVerboseParallel', hasTimeline: true, argCount: 6 },
      { name: 'RunningVerboseSequential', hasTimeline: true, argCount: 6 },
    ],
  },
  {
    title: 'CLI/Sync/Fetch',
    stories: [
      { name: 'FetchResults', hasTimeline: true, argCount: 8 },
      { name: 'FetchNested', hasTimeline: true, argCount: 8 },
      { name: 'FetchIssues', hasTimeline: true, argCount: 8 },
    ],
  },
  {
    title: 'CLI/Add/Results',
    stories: [
      { name: 'AddDefault', hasTimeline: true, argCount: 6 },
      { name: 'AddWithSyncCloned', hasTimeline: true, argCount: 6 },
      { name: 'AddWithSyncError', hasTimeline: true, argCount: 6 },
    ],
  },
]

export const createDefaultState = (): ListStateType =>
  createListState({
    groups: [...componentGroups, ...cliGroups],
    skippedCount: 3,
  })

export const createSmallState = (): ListStateType =>
  createListState({
    groups: componentGroups.slice(0, 2),
    skippedCount: 0,
    packagePath: 'packages/@overeng/tui-react',
  })

export const createEmptyState = (): ListStateType =>
  createListState({
    groups: [],
    skippedCount: 0,
    packagePath: 'packages/@overeng/nonexistent',
  })

export const createLargeState = (): ListStateType =>
  createListState({
    groups: [
      ...componentGroups,
      ...cliGroups,
      ...cliGroups.map((g) =>
        Object.assign({}, g, { title: g.title.replace('CLI/', 'CLI/Store/') }),
      ),
    ],
    skippedCount: 12,
  })
