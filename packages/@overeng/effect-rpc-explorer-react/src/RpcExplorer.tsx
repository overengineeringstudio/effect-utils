import * as stylex from '@stylexjs/stylex'
import * as React from 'react'
import {
  Button,
  Collection,
  Disclosure,
  DisclosurePanel,
  Dialog,
  DialogTrigger,
  Header,
  Heading,
  Input,
  Label,
  ListLayout,
  ListBox,
  ListBoxSection,
  ListBoxItem,
  Modal,
  Popover,
  Select,
  SelectValue,
  TextField,
  Virtualizer,
} from 'react-aria-components'

import type {
  RecordState,
  RequestIdentity,
  RpcDescriptorWire,
  RpcRecord,
} from '@overeng/effect-rpc-explorer'
import { spacing } from '@overeng/stylex-tokens/tokens.stylex'

import {
  createExplorerProjectionStore,
  recordIdentityKey,
  type ExplorerClient,
  type ExplorerProjection,
  type ExplorerProjectionStore,
} from './projection.ts'
import { RpcRecordDetail } from './RpcRecordDetail.tsx'
import { explorerTokens } from './tokens.stylex.ts'
import {
  activeStates,
  descriptorName,
  formatDuration,
  statusByState,
  type StatusTone,
} from './view-model.ts'

/** Initial closed-enum and text filters for the explorer. */
export type { ExplorerInitialFilters, RpcExplorerPresentation, RpcExplorerProps }
/** Dense, transport-neutral Effect RPC diagnostic explorer. */
export { RpcExplorer }

const attention = stylex.keyframes({
  '0%': { borderInlineStartColor: explorerTokens.info },
  '100%': { borderInlineStartColor: explorerTokens.border },
})

const styles = stylex.create({
  root: {
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    minWidth: 0,
    minHeight: '22rem',
    height: 'min(48rem, 80vh)',
    backgroundColor: explorerTokens.canvas,
    color: explorerTokens.text,
    fontFamily: explorerTokens['font-ui'],
    fontSize: explorerTokens['font-size'],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.border,
  },
  toolbar: {
    display: 'grid',
    gridTemplateColumns: 'minmax(24rem, 3fr) minmax(12rem, 2fr) minmax(0, 6fr)',
    alignItems: 'end',
    gap: explorerTokens['density-gap'],
    padding: explorerTokens['density-gap'],
    backgroundColor: explorerTokens['panel-raised'],
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: explorerTokens.border,
  },
  toolbarMedium: { gridTemplateColumns: 'minmax(20rem, 1fr) minmax(0, 2fr)' },
  toolbarCompact: { gridTemplateColumns: 'minmax(0, 1fr)' },
  toolbarSummary: {
    display: 'grid',
    alignSelf: 'stretch',
    alignContent: 'center',
    rowGap: spacing['0.5'],
    minWidth: 0,
    gridColumn: 'auto',
  },
  summaryLine: {
    display: 'flex',
    alignItems: 'baseline',
    gap: explorerTokens['density-gap'],
    minWidth: 0,
  },
  productName: { fontWeight: 600, color: explorerTokens.text, whiteSpace: 'nowrap' },
  metadata: {
    color: explorerTokens['muted-text'],
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  connection: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: explorerTokens['density-block'],
    color: explorerTokens['muted-text'],
    whiteSpace: 'nowrap',
  },
  connectionMark: { color: explorerTokens.success },
  connectionWarning: { color: explorerTokens.warning },
  connectionFailure: { color: explorerTokens.failure },
  searchField: { minWidth: 0 },
  filterDisclosure: { minWidth: 0 },
  filterDisclosureWrapped: { gridColumnStart: '1', gridColumnEnd: '-1' },
  filterTrigger: { display: 'none', width: '100%', justifyContent: 'space-between' },
  filterTriggerCompact: { display: 'flex' },
  filterPanel: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
    alignItems: 'end',
    gap: explorerTokens['density-gap'],
  },
  filterPanelCompact: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  field: { display: 'grid', rowGap: spacing['0.5'], minWidth: 0 },
  label: { color: explorerTokens['muted-text'], fontSize: '0.6875rem', textTransform: 'uppercase' },
  input: {
    boxSizing: 'border-box',
    width: '100%',
    height: explorerTokens['control-height'],
    paddingInline: explorerTokens['density-gap'],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.border,
    backgroundColor: explorerTokens.canvas,
    color: explorerTokens.text,
    fontFamily: explorerTokens['font-data'],
    fontSize: explorerTokens['font-size'],
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  selectButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    minWidth: 0,
    height: explorerTokens['control-height'],
    paddingInline: explorerTokens['density-gap'],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.border,
    backgroundColor: { default: explorerTokens.canvas, '[data-hovered]': explorerTokens.panel },
    color: explorerTokens.text,
    fontSize: explorerTokens['font-size'],
    cursor: 'pointer',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  popover: {
    maxHeight: '18rem',
    overflowY: 'auto',
    backgroundColor: explorerTokens['panel-raised'],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.border,
  },
  option: {
    paddingInline: explorerTokens['density-gap'],
    paddingBlock: explorerTokens['density-block'],
    color: explorerTokens.text,
    backgroundColor: {
      default: 'transparent',
      '[data-focused]': explorerTokens.panel,
      '[data-selected]': explorerTokens['panel-active'],
    },
    cursor: 'pointer',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  button: {
    minHeight: explorerTokens['control-height'],
    paddingInline: explorerTokens['density-gap'],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.border,
    backgroundColor: {
      default: explorerTokens.panel,
      '[data-hovered]': explorerTokens['panel-raised'],
    },
    color: explorerTokens.text,
    fontSize: explorerTokens['font-size'],
    cursor: 'pointer',
    opacity: { default: 1, '[data-disabled]': 0.5 },
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  split: {
    display: { default: 'flex', '@media (max-width: 63.99rem)': 'block' },
    minWidth: 0,
    minHeight: 0,
  },
  forceNarrowSplit: { display: 'block' },
  forceWideSplit: { display: { default: 'flex', '@media (max-width: 63.99rem)': 'block' } },
  paneWidth: (width: number) => ({
    width: { default: `${width}%`, '@media (max-width: 63.99rem)': '100%' },
  }),
  resizeHandle: {
    display: { default: 'block', '@media (max-width: 63.99rem)': 'none' },
    flexGrow: 0,
    flexShrink: 0,
    width: spacing[2],
    padding: 0,
    borderWidth: 0,
    borderInlineStartWidth: 1,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: explorerTokens.border,
    backgroundColor: {
      default: explorerTokens['panel-raised'],
      '[data-hovered]': explorerTokens['panel-active'],
    },
    cursor: 'col-resize',
    touchAction: 'none',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  hiddenResizeHandle: { display: 'none' },
  listPane: {
    display: 'grid',
    gridTemplateRows: 'auto auto minmax(0, 1fr)',
    width: { default: '40%', '@media (max-width: 63.99rem)': '100%' },
    minWidth: { default: '18rem', '@media (max-width: 63.99rem)': 0 },
    maxWidth: { default: '70%', '@media (max-width: 63.99rem)': 'none' },
    height: { default: 'auto', '@media (max-width: 63.99rem)': '100%' },
    resize: 'none',
    overflow: 'hidden',
    backgroundColor: explorerTokens.panel,
    borderInlineEndWidth: 1,
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: explorerTokens.border,
  },
  forceNarrowListPane: {
    width: '100%',
    minWidth: 0,
    maxWidth: 'none',
    height: '100%',
    resize: 'none',
  },
  forceWideListPane: {
    width: { default: '40%', '@media (max-width: 63.99rem)': '100%' },
    minWidth: { default: '18rem', '@media (max-width: 63.99rem)': 0 },
    maxWidth: { default: '70%', '@media (max-width: 63.99rem)': 'none' },
    height: { default: 'auto', '@media (max-width: 63.99rem)': '100%' },
    resize: 'none',
  },
  detailPane: {
    flex: '1',
    minWidth: { default: '22rem', '@media (max-width: 63.99rem)': 0 },
    minHeight: 0,
    overflow: 'auto',
    backgroundColor: explorerTokens.canvas,
    height: { default: 'auto', '@media (max-width: 63.99rem)': '100%' },
  },
  forceNarrowDetailPane: { minWidth: 0, height: '100%' },
  forceWideDetailPane: {
    minWidth: { default: '22rem', '@media (max-width: 63.99rem)': 0 },
    height: { default: 'auto', '@media (max-width: 63.99rem)': '100%' },
  },
  hidden: { display: 'none' },
  sectionHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 1,
    paddingInline: explorerTokens['density-gap'],
    paddingBlock: explorerTokens['density-block'],
    backgroundColor: explorerTokens['panel-raised'],
    color: explorerTokens['muted-text'],
    fontSize: '0.6875rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: explorerTokens.border,
  },
  listHeading: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: explorerTokens['density-gap'],
  },
  quickFilters: { display: 'flex', flexWrap: 'wrap', gap: spacing[1], marginInlineStart: 'auto' },
  quickFilter: {
    paddingInline: explorerTokens['density-inline'],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: { default: explorerTokens.border, '[aria-pressed="true"]': explorerTokens.info },
    backgroundColor: {
      default: explorerTokens.panel,
      '[aria-pressed="true"]': explorerTokens['panel-active'],
    },
    color: explorerTokens.text,
    fontSize: explorerTokens['font-size'],
    cursor: 'pointer',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  columnHeader: {
    display: 'grid',
    gridTemplateColumns:
      'minmax(0, 2fr) minmax(0, .7fr) minmax(0, 1.2fr) minmax(0, .6fr) minmax(0, .9fr)',
    gap: explorerTokens['density-gap'],
    paddingInline: explorerTokens['density-gap'],
    paddingBlock: explorerTokens['density-block'],
    color: explorerTokens['muted-text'],
    fontSize: explorerTokens['font-size'],
    backgroundColor: explorerTokens.panel,
  },
  columnLayout: (rpc: number, side: number, state: number, duration: number, stream: number) => ({
    gridTemplateColumns: `minmax(0, ${rpc}fr) minmax(0, ${side}fr) minmax(0, ${state}fr) minmax(0, ${duration}fr) minmax(0, ${stream}fr)`,
  }),
  compactGrid: {
    gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr)',
    gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
  },
  compactIdentity: { gridColumnStart: '1', gridColumnEnd: '3' },
  compactSide: { gridColumnStart: '1', gridRowStart: '2' },
  compactStatus: { gridColumnStart: '3', gridRowStart: '1' },
  compactDuration: { gridColumnStart: '2', gridRowStart: '2' },
  compactValues: { gridColumnStart: '3', gridRowStart: '2' },
  columnCell: { display: 'flex', position: 'relative', minWidth: 0 },
  columnResize: {
    position: 'absolute',
    insetBlock: 0,
    insetInlineEnd: 0,
    width: spacing[2],
    padding: 0,
    borderWidth: 0,
    borderInlineEndWidth: 1,
    borderInlineEndStyle: 'solid',
    borderInlineEndColor: explorerTokens.border,
    backgroundColor: { default: 'transparent', ':hover': explorerTokens['panel-active'] },
    cursor: 'col-resize',
    touchAction: 'none',
    outline: { default: 'none', ':focus-visible': `2px solid ${explorerTokens['focus-ring']}` },
  },
  columnSort: {
    display: 'inline-flex',
    alignItems: 'center',
    minWidth: 0,
    width: '100%',
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: explorerTokens['muted-text'], '[aria-pressed="true"]': explorerTokens.text },
    font: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  columnResizeHidden: { display: 'none' },
  list: {
    display: 'block',
    minHeight: 0,
    padding: 0,
    overflowY: 'auto',
    scrollbarGutter: 'stable',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
    boxSizing: 'border-box',
  },
  row: {
    display: 'grid',
    gridTemplateColumns:
      'minmax(0, 2fr) minmax(0, .7fr) minmax(0, 1.2fr) minmax(0, .6fr) minmax(0, .9fr)',
    alignItems: 'center',
    minHeight: explorerTokens['row-height'],
    height: explorerTokens['row-height'],
    boxSizing: 'border-box',
    paddingInline: explorerTokens['density-gap'],
    columnGap: explorerTokens['density-gap'],
    borderWidth: { default: null, '@media (forced-colors: active)': 1 },
    borderInlineStartWidth: 2,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: explorerTokens.border,
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: explorerTokens.border,
    backgroundColor: {
      default: 'transparent',
      '[data-hovered]': explorerTokens['panel-raised'],
      '[data-selected]': explorerTokens['panel-active'],
      '[data-focus-visible]': explorerTokens['panel-active'],
    },
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
    cursor: 'pointer',
    animationName: { default: attention, '@media (prefers-reduced-motion: reduce)': 'none' },
    animationDuration: explorerTokens['motion-attention'],
    animationTimingFunction: 'ease-out',
  },
  compactRow: {
    height: `calc(${explorerTokens['row-height']} + ${spacing[4]})`,
    minHeight: `calc(${explorerTokens['row-height']} + ${spacing[4]})`,
  },
  rowPrimary: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowSecondary: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    color: explorerTokens['muted-text'],
    whiteSpace: 'nowrap',
  },
  mono: { fontFamily: explorerTokens['font-data'], fontVariantNumeric: 'tabular-nums' },
  status: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: explorerTokens['density-block'],
    minWidth: 0,
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
  },
  success: { color: explorerTokens.success },
  failure: { color: explorerTokens.failure },
  warning: { color: explorerTokens.warning },
  fault: { color: explorerTokens.fault },
  info: { color: explorerTokens.info },
  empty: { padding: spacing[4], color: explorerTokens['muted-text'] },
  modal: {
    maxWidth: '28rem',
    margin: spacing[4],
    padding: spacing[4],
    backgroundColor: explorerTokens.canvas,
    color: explorerTokens.text,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.border,
  },
  modalActions: { display: 'flex', justifyContent: 'end', gap: explorerTokens['density-gap'] },
  srStatus: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
})

const toneStyle: Record<StatusTone, stylex.StyleXStyles> = {
  success: styles.success,
  failure: styles.failure,
  warning: styles.warning,
  fault: styles.fault,
  info: styles.info,
}

const StatusBadge = ({
  state,
  style,
  compact = false,
}: {
  state: RecordState
  style?: stylex.StyleXStyles
  compact?: boolean
}): React.ReactNode => {
  const status = statusByState[state]
  return (
    <span
      aria-label={`Lifecycle: ${status.label}`}
      title={status.label}
      {...stylex.props(styles.status, toneStyle[status.tone], style)}
    >
      <span aria-hidden="true">{status.symbol}</span>
      {compact === true ? (status.compactLabel ?? status.label) : status.label}
    </span>
  )
}

const stableDomId = (key: RequestIdentity): string => {
  const input = recordIdentityKey(key)
  let hash = 2_166_136_261
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 16_777_619)
  }
  return `rpc-record-${(hash >>> 0).toString(36)}`
}

interface Filters {
  readonly search: string
  readonly state: 'all' | 'active' | 'completed' | 'failures' | RecordState
  readonly side: 'all' | RequestIdentity['observerSide']
  readonly direction: 'all' | RequestIdentity['direction']
  readonly descriptor: 'all' | string
  readonly sort:
    | 'newest'
    | 'oldest'
    | 'duration'
    | 'durationAsc'
    | 'rpcAsc'
    | 'rpcDesc'
    | 'sideAsc'
    | 'sideDesc'
    | 'stateAsc'
    | 'stateDesc'
    | 'streamAsc'
    | 'streamDesc'
}

const sortColumns: ReadonlyArray<{
  readonly label: string
  readonly ascending: Filters['sort']
  readonly descending: Filters['sort']
  readonly initial: Filters['sort']
}> = [
  { label: 'RPC', ascending: 'rpcAsc', descending: 'rpcDesc', initial: 'rpcAsc' },
  { label: 'Side', ascending: 'sideAsc', descending: 'sideDesc', initial: 'sideAsc' },
  { label: 'State', ascending: 'stateAsc', descending: 'stateDesc', initial: 'stateAsc' },
  { label: 'Duration', ascending: 'durationAsc', descending: 'duration', initial: 'duration' },
  { label: 'Env / Val', ascending: 'streamAsc', descending: 'streamDesc', initial: 'streamDesc' },
]

const compactColumnStyles = [
  styles.compactIdentity,
  styles.compactSide,
  styles.compactStatus,
  styles.compactDuration,
  styles.compactValues,
] as const

interface ExplorerInitialFilters {
  readonly search?: string
  readonly state?: Filters['state']
  readonly side?: Filters['side']
  readonly direction?: Filters['direction']
  readonly descriptor?: Filters['descriptor']
  readonly sort?: Filters['sort']
}

interface RpcExplorerPresentation {
  readonly layout?: 'auto' | 'wide' | 'narrow'
  readonly nowMillis?: () => number
  readonly style?: stylex.StyleXStyles
}

interface RpcExplorerProps {
  readonly client: ExplorerClient
  readonly initialFilters?: ExplorerInitialFilters
  readonly presentation?: RpcExplorerPresentation
}

const SelectFilter = ({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: ReadonlyArray<{ readonly id: string; readonly label: string }>
  onChange: (value: string) => void
}): React.ReactNode => (
  <Select
    aria-label={label}
    value={value}
    onChange={(key) => onChange(String(key))}
    {...stylex.props(styles.field)}
  >
    <Label {...stylex.props(styles.label)}>{label}</Label>
    <Button {...stylex.props(styles.selectButton)}>
      <SelectValue />
      <span aria-hidden="true">▾</span>
    </Button>
    <Popover {...stylex.props(styles.popover)}>
      <ListBox items={options}>
        {(option) => (
          <ListBoxItem id={option.id} {...stylex.props(styles.option)}>
            {option.label}
          </ListBoxItem>
        )}
      </ListBox>
    </Popover>
  </Select>
)

const failureStates: ReadonlySet<RecordState> = new Set([
  'sendFailed',
  'failed',
  'defect',
  'uncertain',
])

const recordMatches = ({
  record,
  descriptor,
  bucket,
  filters,
}: {
  record: RpcRecord
  descriptor: RpcDescriptorWire | undefined
  bucket: 'active' | 'completed'
  filters: Filters
}): boolean => {
  if (filters.state === 'active' && bucket !== 'active') return false
  if (filters.state === 'completed' && bucket !== 'completed') return false
  if (filters.state === 'failures' && failureStates.has(record.state) === false) return false
  if (
    filters.state !== 'all' &&
    filters.state !== 'active' &&
    filters.state !== 'completed' &&
    filters.state !== 'failures' &&
    record.state !== filters.state
  )
    return false
  if (filters.side !== 'all' && record.key.observerSide !== filters.side) return false
  if (filters.direction !== 'all' && record.key.direction !== filters.direction) return false
  if (filters.descriptor !== 'all' && record.descriptorId !== filters.descriptor) return false
  const search = filters.search.trim().toLocaleLowerCase()
  if (search === '') return true
  const status = statusByState[record.state].label
  return [descriptor?.key, descriptor?.tag, status].some(
    (candidate) => candidate?.toLocaleLowerCase().includes(search) === true,
  )
}

const RecordRow = ({
  record,
  descriptor,
  nowMillis,
  compact,
  columnLayout,
}: {
  record: RpcRecord
  descriptor: RpcDescriptorWire | undefined
  nowMillis: number
  compact: boolean
  columnLayout: stylex.StyleXStyles | undefined
}): React.ReactNode => {
  const durationEnd =
    activeStates.has(record.state) === true ? nowMillis : record.lastAt.wallClockMillis
  const retainedMarker = record.retainedStreamValues < record.streamValues ? ' · truncated' : ''
  const direction =
    record.key.direction === 'clientToServer' ? 'Client → server' : 'Server → client'
  return (
    <ListBoxItem
      id={recordIdentityKey(record.key)}
      data-record-id={stableDomId(record.key)}
      textValue={`${descriptorName(descriptor)} ${statusByState[record.state].label}`}
      aria-label={`${descriptorName(descriptor)}. ${descriptor?.summary === undefined ? '' : `${descriptor.summary}${descriptor.summary.endsWith('.') === true ? '' : '.'} `}${record.key.observerSide}, ${direction}. ${statusByState[record.state].label}. Started ${formatDuration(nowMillis - record.startedAt.wallClockMillis)} ago; duration ${formatDuration(durationEnd - record.startedAt.wallClockMillis)}; ${record.chunkEnvelopes} envelopes, ${record.streamValues} values${retainedMarker}; ${record.trace === undefined ? 'no trace' : 'trace linked'}${record.evidence.length === 0 ? '' : '; anomaly observed'}.`}
      {...stylex.props(
        styles.row,
        columnLayout,
        compact === true ? styles.compactGrid : undefined,
        compact === true ? styles.compactRow : undefined,
      )}
    >
      <span
        {...stylex.props(
          styles.rowPrimary,
          styles.mono,
          compact === true ? styles.compactIdentity : undefined,
        )}
        title={
          descriptor?.summary === undefined
            ? descriptorName(descriptor)
            : `${descriptorName(descriptor)} — ${descriptor.summary}`
        }
      >
        {descriptorName(descriptor)}
      </span>
      <span
        {...stylex.props(styles.rowSecondary, compact === true ? styles.compactSide : undefined)}
        title={`${record.key.observerSide} · ${direction}`}
      >
        <span aria-hidden="true">{record.key.direction === 'clientToServer' ? '→' : '←'} </span>
        {record.key.observerSide}
      </span>
      <StatusBadge
        state={record.state}
        compact={compact}
        style={compact === true ? styles.compactStatus : undefined}
      />
      <span
        {...stylex.props(
          styles.rowSecondary,
          styles.mono,
          compact === true ? styles.compactDuration : undefined,
        )}
      >
        {formatDuration(durationEnd - record.startedAt.wallClockMillis)}
      </span>
      <span
        {...stylex.props(
          styles.rowSecondary,
          styles.mono,
          compact === true ? styles.compactValues : undefined,
        )}
        title={`${record.chunkEnvelopes} envelopes / ${record.streamValues} values${retainedMarker === '' ? '' : '; retained values truncated'}; ${record.trace === undefined ? 'no trace' : 'trace linked'}${record.evidence.length === 0 ? '' : '; anomaly observed'}`}
      >
        {record.chunkEnvelopes}/{record.streamValues}
        {record.trace === undefined ? '' : ' · trace'}
        {retainedMarker === '' ? '' : ' · truncated'}
        {record.evidence.length === 0 ? '' : ' · anomaly'}
      </span>
    </ListBoxItem>
  )
}

const connectionText = (projection: ExplorerProjection): string => {
  switch (projection.connection._tag) {
    case 'loading':
      return 'Loading inspector snapshot'
    case 'live':
      return 'Inspector connected'
    case 'recovering':
      return `Inspector recovering: ${projection.connection.reason}`
    case 'disconnected':
      return `Inspector disconnected: ${projection.connection.message}`
    case 'error':
      return `Inspector error: ${projection.connection.message}`
  }
}

const useProjection = (store: ExplorerProjectionStore): ExplorerProjection =>
  React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

const useNowMillis = ({
  hasRecords,
  injectedNowMillis,
}: {
  readonly hasRecords: boolean
  readonly injectedNowMillis: (() => number) | undefined
}): number => {
  const [sample, setSample] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (hasRecords === false || injectedNowMillis !== undefined) return
    setSample(Date.now())
    const interval = globalThis.setInterval(() => setSample(Date.now()), 1_000)
    return () => globalThis.clearInterval(interval)
  }, [hasRecords, injectedNowMillis])

  return injectedNowMillis?.() ?? sample
}

type ColumnWidths = readonly [number, number, number, number, number]
const defaultColumnWidths: ColumnWidths = [2, 0.7, 1.2, 0.6, 0.9]
const totalColumnUnits = defaultColumnWidths.reduce((sum, width) => sum + width, 0)

/** Dense, transport-neutral Effect RPC diagnostic explorer. */
const RpcExplorer = ({
  client,
  initialFilters,
  presentation,
}: RpcExplorerProps): React.ReactNode => {
  const store = React.useMemo(() => createExplorerProjectionStore(client), [client])
  const projection = useProjection(store)
  const resizeHelpId = React.useId()
  const [filters, setFilters] = React.useState<Filters>({
    search: initialFilters?.search ?? '',
    state: initialFilters?.state ?? 'all',
    side: initialFilters?.side ?? 'all',
    direction: initialFilters?.direction ?? 'all',
    descriptor: initialFilters?.descriptor ?? 'all',
    sort: initialFilters?.sort ?? 'oldest',
  })
  const [columnWidths, setColumnWidths] = React.useState<ColumnWidths>(defaultColumnWidths)
  const columnHeaderRef = React.useRef<HTMLDivElement>(null)
  const columnDrag = React.useRef<
    | {
        readonly index: number
        readonly startX: number
        readonly widths: ColumnWidths
        readonly headerWidth: number
      }
    | undefined
  >(undefined)
  const resizeColumn = ({
    index,
    delta,
    origin = columnWidths,
  }: {
    readonly index: number
    readonly delta: number
    readonly origin?: ColumnWidths
  }): void => {
    const next = [...origin] as [number, number, number, number, number]
    const change = Math.max(0.45 - next[index]!, Math.min(next[index + 1]! - 0.45, delta))
    next[index] = next[index]! + change
    next[index + 1] = next[index + 1]! - change
    setColumnWidths(next)
  }
  const [selectedKey, setSelectedKey] = React.useState<string | undefined>(undefined)
  const [narrowDetail, setNarrowDetail] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const [filtersExpanded, setFiltersExpanded] = React.useState(false)
  const listRef = React.useRef<HTMLDivElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const [containerWidth, setContainerWidth] = React.useState(0)
  const measureRoot = React.useCallback((node: HTMLElement | null) => {
    if (node === null) return
    const observer = new ResizeObserver(() => setContainerWidth(node.clientWidth))
    observer.observe(node)
    setContainerWidth(node.clientWidth)
    return () => observer.disconnect()
  }, [])
  const originatingRowId = React.useRef<string | undefined>(undefined)
  const priorRecordKeys = React.useRef<ReadonlySet<string>>(new Set())
  const [paneWidth, setPaneWidth] = React.useState(() => {
    try {
      const saved = Number(globalThis.localStorage.getItem('rpc-explorer-pane-width'))
      return saved >= 30 && saved <= 60 ? saved : 40
    } catch {
      return 40
    }
  })
  const resizePane = (width: number): void => {
    const next = Math.max(30, Math.min(60, width))
    setPaneWidth(next)
    try {
      globalThis.localStorage.setItem('rpc-explorer-pane-width', String(next))
    } catch {
      /* storage may be disabled */
    }
  }

  // oxlint-disable-next-line overeng/named-args -- Array#sort comparator receives positional arguments.
  const compareRecords = (a: RpcRecord, b: RpcRecord): number => {
    switch (filters.sort) {
      case 'duration':
      case 'durationAsc': {
        const difference =
          a.lastAt.wallClockMillis -
          a.startedAt.wallClockMillis -
          (b.lastAt.wallClockMillis - b.startedAt.wallClockMillis)
        return filters.sort === 'duration' ? -difference : difference
      }
      case 'rpcAsc':
      case 'rpcDesc': {
        const left = projection.descriptors.get(a.descriptorId)?.key ?? a.descriptorId
        const right = projection.descriptors.get(b.descriptorId)?.key ?? b.descriptorId
        return filters.sort === 'rpcAsc' ? left.localeCompare(right) : right.localeCompare(left)
      }
      case 'sideAsc':
      case 'sideDesc':
        return filters.sort === 'sideAsc'
          ? a.key.observerSide.localeCompare(b.key.observerSide)
          : b.key.observerSide.localeCompare(a.key.observerSide)
      case 'stateAsc':
      case 'stateDesc':
        return filters.sort === 'stateAsc'
          ? statusByState[a.state].label.localeCompare(statusByState[b.state].label)
          : statusByState[b.state].label.localeCompare(statusByState[a.state].label)
      case 'streamAsc':
      case 'streamDesc':
        return filters.sort === 'streamAsc'
          ? a.streamValues - b.streamValues || a.chunkEnvelopes - b.chunkEnvelopes
          : b.streamValues - a.streamValues || b.chunkEnvelopes - a.chunkEnvelopes
      case 'oldest':
        return a.startedAt.wallClockMillis - b.startedAt.wallClockMillis
      case 'newest':
        return b.startedAt.wallClockMillis - a.startedAt.wallClockMillis
    }
  }
  const active = [...projection.active.values()]
    .filter((record) =>
      recordMatches({
        record,
        descriptor: projection.descriptors.get(record.descriptorId),
        bucket: 'active',
        filters,
      }),
    )
    // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array; toSorted would copy it again.
    .sort(compareRecords)
  const completed = [...projection.completed.values()]
    .filter((record) =>
      recordMatches({
        record,
        descriptor: projection.descriptors.get(record.descriptorId),
        bucket: 'completed',
        filters,
      }),
    )
    // oxlint-disable-next-line unicorn/no-array-sort -- filter returns a fresh array; toSorted would copy it again.
    .sort(compareRecords)
  const allRecords = React.useMemo(
    () => new Map([...projection.active, ...projection.completed]),
    [projection.active, projection.completed],
  )
  let failuresCount = 0
  for (const record of allRecords.values())
    if (failureStates.has(record.state) === true) failuresCount += 1
  const selected = selectedKey === undefined ? undefined : allRecords.get(selectedKey)
  const selectedExistsUnfiltered = selectedKey !== undefined && allRecords.has(selectedKey)
  const selectedVisible =
    selectedKey !== undefined &&
    [...active, ...completed].some((record) => recordIdentityKey(record.key) === selectedKey)
  const nowMillis = useNowMillis({
    hasRecords: allRecords.size > 0,
    injectedNowMillis: presentation?.nowMillis,
  })
  const recordSections = [
    {
      id: 'active',
      label: `Active · ${active.length}`,
      items: active.map((record) => ({ id: recordIdentityKey(record.key), record })),
    },
    {
      id: 'completed',
      label: `Completed · ${completed.length}`,
      items: completed.map((record) => ({ id: recordIdentityKey(record.key), record })),
    },
  ] as const

  React.useEffect(() => {
    const currentKeys = new Set(allRecords.keys())
    if (
      selectedKey !== undefined &&
      priorRecordKeys.current.has(selectedKey) === true &&
      currentKeys.has(selectedKey) === false
    ) {
      setSelectedKey(undefined)
      setNarrowDetail(false)
      setNotice('Selected record expired from bounded history')
      globalThis.requestAnimationFrame(() => listRef.current?.focus())
    } else if (
      selectedKey !== undefined &&
      selectedExistsUnfiltered === true &&
      selectedVisible === false
    ) {
      setNotice('Selected record is filtered out')
    } else if (selectedVisible === true) {
      setNotice('')
    }
    priorRecordKeys.current = currentKeys
  }, [allRecords, projection.revision, selectedKey, selectedExistsUnfiltered, selectedVisible])

  const selectRecord = (key: string): void => {
    setSelectedKey(key)
    setNarrowDetail(true)
    const record = allRecords.get(key)
    originatingRowId.current = record === undefined ? undefined : stableDomId(record.key)
  }
  const returnToList = (): void => {
    setNarrowDetail(false)
    globalThis.requestAnimationFrame(() => {
      const rowId = originatingRowId.current
      const row =
        rowId === undefined
          ? undefined
          : listRef.current?.querySelector<HTMLElement>(`[data-record-id="${rowId}"]`)
      ;(row ?? listRef.current)?.focus()
    })
  }

  const stateOptions = [
    { id: 'all', label: 'All states' },
    { id: 'active', label: 'Active' },
    { id: 'failures', label: 'Failures' },
    { id: 'completed', label: 'Completed' },
    ...Object.entries(statusByState).map(([id, status]) => ({ id, label: status.label })),
  ]
  const descriptorOptions = [
    { id: 'all', label: 'All descriptors' },
    ...[...projection.descriptors.values()].map((descriptor) => ({
      id: descriptor.descriptorId,
      label: descriptorName(descriptor),
    })),
  ]
  const singlePane = presentation?.layout === 'narrow' || containerWidth < 1200
  const compactRows =
    singlePane === true || selected === undefined
      ? containerWidth < 600
      : (containerWidth * paneWidth) / 100 < 600
  const columnLayout = compactRows === true ? undefined : styles.columnLayout(...columnWidths)
  const listVisibility = singlePane === true && narrowDetail === true ? styles.hidden : undefined
  const detailVisibility =
    selected === undefined || (singlePane === true && narrowDetail === false)
      ? styles.hidden
      : undefined

  return (
    <main
      {...stylex.props(styles.root, presentation?.style)}
      ref={measureRoot}
      data-layout={presentation?.layout ?? 'auto'}
      onKeyDown={(event) => {
        if (
          event.key !== '/' ||
          event.defaultPrevented === true ||
          event.altKey === true ||
          event.ctrlKey === true ||
          event.metaKey === true
        )
          return
        const target = event.target
        if (
          target instanceof HTMLElement === false ||
          event.currentTarget.contains(target) === false ||
          target.closest(
            'input, textarea, select, [contenteditable], [role="dialog"], [role="menu"], [role="listbox"]',
          ) !== null
        )
          return
        event.preventDefault()
        searchRef.current?.focus()
      }}
    >
      <header
        {...stylex.props(
          styles.toolbar,
          containerWidth < 768 ? styles.toolbarCompact : undefined,
          containerWidth >= 768 && containerWidth < 1200 ? styles.toolbarMedium : undefined,
        )}
      >
        <div {...stylex.props(styles.toolbarSummary)}>
          <div {...stylex.props(styles.summaryLine)}>
            <span {...stylex.props(styles.productName)}>RPC Explorer</span>
            <span
              role="img"
              aria-label={connectionText(projection)}
              title={connectionText(projection)}
              {...stylex.props(styles.connection)}
            >
              <span
                aria-hidden="true"
                {...stylex.props(
                  projection.connection._tag === 'live'
                    ? styles.connectionMark
                    : projection.connection._tag === 'loading' ||
                        projection.connection._tag === 'recovering'
                      ? styles.connectionWarning
                      : styles.connectionFailure,
                )}
              >
                ●
              </span>
              {projection.connection._tag === 'live' ? 'Live' : projection.connection._tag}
            </span>
          </div>
          <div {...stylex.props(styles.summaryLine)}>
            <span
              {...stylex.props(styles.metadata)}
              title={`${projection.active.size} active · ${projection.completed.size} completed · revision ${projection.revision ?? 'unknown'}`}
            >
              {projection.active.size} active · {projection.completed.size} done · r
              {projection.revision ?? '—'}
            </span>
            {projection.counters.completedEvicted + projection.counters.activeEvicted > 0 ? (
              <span
                {...stylex.props(styles.metadata)}
                title={`${projection.counters.completedEvicted + projection.counters.activeEvicted} records expired by retention`}
              >
                {projection.counters.completedEvicted + projection.counters.activeEvicted} expired
              </span>
            ) : undefined}
            {projection.resetReason === undefined ? undefined : (
              <span
                {...stylex.props(styles.metadata)}
                title={`Last reset: ${projection.resetReason}`}
              >
                Reset
              </span>
            )}
          </div>
        </div>
        <TextField
          value={filters.search}
          onChange={(search) => setFilters((current) => ({ ...current, search }))}
          {...stylex.props(styles.field, styles.searchField)}
        >
          <Label {...stylex.props(styles.label)}>
            Filter key, tag, or status <span aria-hidden="true">· /</span>
          </Label>
          <Input ref={searchRef} {...stylex.props(styles.input)} placeholder="Filter records" />
        </TextField>
        <Disclosure
          isExpanded={containerWidth >= 768 || filtersExpanded === true}
          onExpandedChange={setFiltersExpanded}
          {...stylex.props(
            styles.filterDisclosure,
            containerWidth < 1200 ? styles.filterDisclosureWrapped : undefined,
          )}
        >
          <Button
            slot="trigger"
            {...stylex.props(
              styles.button,
              styles.filterTrigger,
              containerWidth < 768 ? styles.filterTriggerCompact : undefined,
            )}
          >
            <span>
              Filters and actions
              {filters.state === 'all' ? '' : ` · ${filters.state}`}
              {filters.side === 'all' ? '' : ` · ${filters.side}`}
              {filters.descriptor === 'all' ? '' : ' · descriptor selected'}
            </span>
            <span aria-hidden="true">{filtersExpanded === true ? '▴' : '▾'}</span>
          </Button>
          <DisclosurePanel
            {...stylex.props(
              styles.filterPanel,
              containerWidth < 768 ? styles.filterPanelCompact : undefined,
            )}
          >
            <SelectFilter
              label="State"
              value={filters.state}
              options={stateOptions}
              onChange={(state) =>
                setFilters((current) => ({ ...current, state: state as Filters['state'] }))
              }
            />
            <SelectFilter
              label="Side"
              value={filters.side}
              options={[
                { id: 'all', label: 'All sides' },
                { id: 'client', label: 'Client' },
                { id: 'server', label: 'Server' },
              ]}
              onChange={(side) =>
                setFilters((current) => ({ ...current, side: side as Filters['side'] }))
              }
            />
            <SelectFilter
              label="Direction"
              value={filters.direction}
              options={[
                { id: 'all', label: 'All directions' },
                { id: 'clientToServer', label: 'Client → server' },
                { id: 'serverToClient', label: 'Server → client' },
              ]}
              onChange={(direction) =>
                setFilters((current) => ({
                  ...current,
                  direction: direction as Filters['direction'],
                }))
              }
            />
            <SelectFilter
              label="Descriptor"
              value={filters.descriptor}
              options={descriptorOptions}
              onChange={(descriptor) => setFilters((current) => ({ ...current, descriptor }))}
            />
            <SelectFilter
              label="Sort"
              value={filters.sort}
              options={[
                { id: 'newest', label: 'Newest first' },
                { id: 'oldest', label: 'Oldest first' },
                { id: 'duration', label: 'Longest first' },
                { id: 'durationAsc', label: 'Shortest first' },
                { id: 'rpcAsc', label: 'RPC A → Z' },
                { id: 'rpcDesc', label: 'RPC Z → A' },
                { id: 'sideAsc', label: 'Side A → Z' },
                { id: 'sideDesc', label: 'Side Z → A' },
                { id: 'stateAsc', label: 'State A → Z' },
                { id: 'stateDesc', label: 'State Z → A' },
                { id: 'streamAsc', label: 'Fewest values first' },
                { id: 'streamDesc', label: 'Most values first' },
              ]}
              onChange={(sort) =>
                setFilters((current) => ({ ...current, sort: sort as Filters['sort'] }))
              }
            />
            <div {...stylex.props(styles.field)}>
              <Label {...stylex.props(styles.label)}>Diagnostics</Label>
              {projection.connection._tag === 'disconnected' ||
              projection.connection._tag === 'error' ? (
                <Button {...stylex.props(styles.button)} onPress={store.reconnect}>
                  Reconnect
                </Button>
              ) : (
                <DialogTrigger>
                  <Button
                    isDisabled={clearing === true || projection.stale === true}
                    {...stylex.props(styles.button)}
                  >
                    Clear history
                  </Button>
                  <Modal isDismissable={true}>
                    <Dialog {...stylex.props(styles.modal)}>
                      {({ close }) => (
                        <>
                          <Heading slot="title" level={2}>
                            Clear diagnostic history?
                          </Heading>
                          <p>
                            This removes completed explorer history while keeping active observed
                            calls correlatable. It does not cancel, retry, or otherwise affect
                            application RPCs.
                          </p>
                          <div {...stylex.props(styles.modalActions)}>
                            <Button {...stylex.props(styles.button)} onPress={close}>
                              Keep history
                            </Button>
                            <Button
                              {...stylex.props(styles.button)}
                              onPress={() => {
                                setClearing(true)
                                close()
                                void store
                                  .clearHistory()
                                  .catch(() => undefined)
                                  .finally(() => setClearing(false))
                              }}
                            >
                              Clear diagnostic history
                            </Button>
                          </div>
                        </>
                      )}
                    </Dialog>
                  </Modal>
                </DialogTrigger>
              )}
            </div>
          </DisclosurePanel>
        </Disclosure>
      </header>
      <div
        {...stylex.props(
          styles.split,
          singlePane === true ? styles.forceNarrowSplit : styles.forceWideSplit,
        )}
      >
        <section
          aria-label="RPC records"
          {...stylex.props(
            styles.listPane,
            singlePane === true || selected === undefined
              ? styles.forceNarrowListPane
              : styles.forceWideListPane,
            singlePane === true || selected === undefined ? undefined : styles.paneWidth(paneWidth),
            listVisibility,
          )}
        >
          <div {...stylex.props(styles.sectionHeader, styles.listHeading)}>
            <span>{active.length + completed.length} matching records</span>
            <div
              role="group"
              aria-label="Quick state filters"
              {...stylex.props(styles.quickFilters)}
            >
              {(
                [
                  ['all', 'All', allRecords.size],
                  ['active', 'Active', projection.active.size],
                  ['failures', 'Failures', failuresCount],
                ] as const
              ).map(([state, label, count]) => (
                <Button
                  key={state}
                  aria-pressed={filters.state === state}
                  {...stylex.props(styles.quickFilter)}
                  onPress={() => setFilters((current) => ({ ...current, state }))}
                >
                  {label} {count}
                </Button>
              ))}
            </div>
          </div>
          <div
            role="toolbar"
            aria-label="Record sorting and column widths"
            {...stylex.props(
              styles.columnHeader,
              columnLayout,
              compactRows === true ? styles.compactGrid : undefined,
            )}
            ref={columnHeaderRef}
          >
            {sortColumns.map((column, index) => {
              const direction =
                filters.sort === column.ascending
                  ? 'ascending'
                  : filters.sort === column.descending
                    ? 'descending'
                    : 'inactive'
              return (
                <span
                  key={column.label}
                  title={index === sortColumns.length - 1 ? 'Envelopes / values' : undefined}
                  {...stylex.props(
                    styles.columnCell,
                    compactRows === true ? compactColumnStyles[index] : undefined,
                  )}
                >
                  <Button
                    aria-label={`Sort ${column.label}: ${direction}`}
                    aria-pressed={direction !== 'inactive'}
                    aria-description={
                      index === sortColumns.length - 1
                        ? 'Envelope count / stream value count. Select to sort by stream values.'
                        : undefined
                    }
                    {...stylex.props(styles.columnSort)}
                    onPress={() =>
                      setFilters((current) => ({
                        ...current,
                        sort:
                          current.sort === column.initial
                            ? column.initial === column.ascending
                              ? column.descending
                              : column.ascending
                            : column.initial,
                      }))
                    }
                  >
                    {column.label}
                    {direction === 'inactive' ? undefined : (
                      <span aria-hidden="true">{direction === 'ascending' ? ' ↑' : ' ↓'}</span>
                    )}
                  </Button>
                  {index === sortColumns.length - 1 ? undefined : (
                    <div
                      role="separator"
                      tabIndex={compactRows === true ? -1 : 0}
                      aria-label={`Resize ${column.label} column`}
                      aria-orientation="vertical"
                      aria-valuemin={Math.round((100 * 0.45) / totalColumnUnits)}
                      aria-valuemax={Math.round(
                        (100 * (columnWidths[index]! + columnWidths[index + 1]! - 0.45)) /
                          totalColumnUnits,
                      )}
                      aria-valuenow={Math.round((100 * columnWidths[index]!) / totalColumnUnits)}
                      aria-valuetext={`${Math.round((100 * columnWidths[index]!) / totalColumnUnits)} percent wide; use Left and Right arrows`}
                      {...stylex.props(
                        styles.columnResize,
                        compactRows === true ? styles.columnResizeHidden : undefined,
                      )}
                      onKeyDown={(event) => {
                        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                        event.preventDefault()
                        resizeColumn({ index, delta: event.key === 'ArrowRight' ? 0.2 : -0.2 })
                      }}
                      onPointerDown={(event) => {
                        if (event.pointerType === 'mouse' && event.button !== 0) return
                        columnDrag.current = {
                          index,
                          startX: event.clientX,
                          widths: columnWidths,
                          headerWidth: columnHeaderRef.current?.clientWidth ?? 1,
                        }
                        event.currentTarget.setPointerCapture(event.pointerId)
                      }}
                      onPointerMove={(event) => {
                        const drag = columnDrag.current
                        if (
                          drag === undefined ||
                          drag.index !== index ||
                          event.currentTarget.hasPointerCapture(event.pointerId) === false
                        )
                          return
                        resizeColumn({
                          index,
                          delta:
                            ((event.clientX - drag.startX) / drag.headerWidth) * totalColumnUnits,
                          origin: drag.widths,
                        })
                      }}
                      onPointerUp={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId) === true)
                          event.currentTarget.releasePointerCapture(event.pointerId)
                        columnDrag.current = undefined
                      }}
                      onPointerCancel={() => {
                        columnDrag.current = undefined
                      }}
                    />
                  )}
                </span>
              )
            })}
          </div>
          <Virtualizer
            layout={ListLayout}
            layoutOptions={{ estimatedRowSize: 32, estimatedHeadingSize: 24 }}
            shouldObserveItemSize={true}
          >
            <ListBox
              ref={listRef}
              aria-label="Observed RPC records"
              selectionMode="single"
              items={recordSections}
              selectionBehavior="toggle"
              selectedKeys={selectedKey === undefined ? new Set() : new Set([selectedKey])}
              onSelectionChange={(keys) => {
                if (keys === 'all') return
                const first = keys.values().next().value
                if (typeof first === 'string') selectRecord(first)
              }}
              onAction={(key) => selectRecord(String(key))}
              {...stylex.props(styles.list)}
            >
              {(section) => (
                <ListBoxSection id={section.id}>
                  <Header {...stylex.props(styles.sectionHeader)}>{section.label}</Header>
                  <Collection items={section.items}>
                    {(item) => (
                      <RecordRow
                        record={item.record}
                        descriptor={projection.descriptors.get(item.record.descriptorId)}
                        nowMillis={nowMillis}
                        compact={compactRows}
                        columnLayout={columnLayout}
                      />
                    )}
                  </Collection>
                </ListBoxSection>
              )}
            </ListBox>
          </Virtualizer>
          {active.length + completed.length === 0 ? (
            <p {...stylex.props(styles.empty)}>
              {projection.connection._tag === 'loading'
                ? 'Loading the inspector snapshot…'
                : allRecords.size === 0
                  ? 'Waiting for observed RPCs. Captured calls will appear here.'
                  : 'No matching records. Change or clear a filter to see other calls.'}
            </p>
          ) : undefined}
        </section>
        <span id={resizeHelpId} {...stylex.props(styles.srStatus)}>
          Record pane {Math.round(paneWidth)} percent wide. Use Left and Right arrow keys to resize.
        </span>
        <Button
          aria-label="Resize record pane"
          aria-describedby={resizeHelpId}
          {...stylex.props(
            styles.resizeHandle,
            singlePane === true || selected === undefined ? styles.hiddenResizeHandle : undefined,
          )}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              resizePane(paneWidth + (event.key === 'ArrowRight' ? 5 : -5))
            }
          }}
          onPointerDown={(event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId) === false) return
            const bounds = event.currentTarget.parentElement?.getBoundingClientRect()
            if (bounds !== undefined)
              resizePane((100 * (event.clientX - bounds.left)) / bounds.width)
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        />
        <section
          aria-label="Selected RPC record"
          {...stylex.props(
            styles.detailPane,
            singlePane === true ? styles.forceNarrowDetailPane : styles.forceWideDetailPane,
            detailVisibility,
          )}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && narrowDetail === true) returnToList()
          }}
        >
          {selected === undefined ? (
            <p {...stylex.props(styles.empty)}>
              Select an observed RPC record to inspect its lifecycle and policy-safe content.
            </p>
          ) : (
            <RpcRecordDetail
              record={selected}
              descriptor={projection.descriptors.get(selected.descriptorId)}
              projection={projection}
              nowMillis={nowMillis}
              onBack={returnToList}
              backVisibility={singlePane === true ? 'always' : 'never'}
            />
          )}
        </section>
      </div>
      <div role="status" aria-live="polite" aria-atomic="true" {...stylex.props(styles.srStatus)}>
        {`${notice === '' ? '' : `${notice}. `}${projection.active.size} active and ${projection.completed.size} completed records. ${connectionText(projection)}${projection.resetReason === undefined ? '' : `. Reset reason: ${projection.resetReason}`}`}
      </div>
    </main>
  )
}
