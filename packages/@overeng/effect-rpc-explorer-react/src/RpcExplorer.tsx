import * as stylex from '@stylexjs/stylex'
import * as React from 'react'
import {
  Button,
  Collection,
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
    gridTemplateColumns: {
      default: 'auto minmax(10rem, 1fr) repeat(4, minmax(7rem, auto)) auto',
      '@media (max-width: 47.99rem)': 'repeat(2, minmax(0, 1fr))',
    },
    alignItems: 'end',
    gap: explorerTokens['density-gap'],
    padding: explorerTokens['density-gap'],
    backgroundColor: explorerTokens['panel-raised'],
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: explorerTokens.border,
  },
  toolbarSummary: {
    display: 'grid',
    alignSelf: 'stretch',
    alignContent: 'center',
    minWidth: '12rem',
    gridColumn: { default: 'auto', '@media (max-width: 47.99rem)': '1 / -1' },
  },
  productName: { fontWeight: 600, color: explorerTokens.text },
  metadata: { color: explorerTokens['muted-text'], fontVariantNumeric: 'tabular-nums' },
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
    outline: 'none',
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
    display: { default: 'flex', '@media (max-width: 47.99rem)': 'block' },
    minWidth: 0,
    minHeight: 0,
  },
  forceNarrowSplit: { display: 'block' },
  forceWideSplit: { display: 'flex' },
  listPane: {
    display: 'grid',
    gridTemplateRows: 'auto minmax(0, 1fr)',
    width: { default: '40%', '@media (max-width: 47.99rem)': '100%' },
    minWidth: { default: '18rem', '@media (max-width: 47.99rem)': 0 },
    maxWidth: { default: '70%', '@media (max-width: 47.99rem)': 'none' },
    height: { default: 'auto', '@media (max-width: 47.99rem)': '100%' },
    resize: { default: 'horizontal', '@media (max-width: 47.99rem)': 'none' },
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
    width: '40%',
    minWidth: '18rem',
    maxWidth: '70%',
    height: 'auto',
    resize: 'horizontal',
  },
  detailPane: {
    flex: '1',
    minWidth: { default: '22rem', '@media (max-width: 47.99rem)': 0 },
    minHeight: 0,
    overflow: 'auto',
    backgroundColor: explorerTokens.canvas,
    height: { default: 'auto', '@media (max-width: 47.99rem)': '100%' },
  },
  forceNarrowDetailPane: { minWidth: 0, height: '100%' },
  forceWideDetailPane: { minWidth: '22rem', height: 'auto' },
  hidden: { display: 'none' },
  hiddenAtNarrow: { display: { default: null, '@media (max-width: 47.99rem)': 'none' } },
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
  list: {
    display: 'block',
    minHeight: 0,
    padding: 0,
    overflowY: 'auto',
    scrollbarGutter: 'stable',
    outline: 'none',
    boxSizing: 'border-box',
  },
  row: {
    display: 'grid',
    gridTemplateColumns:
      'minmax(9rem, 1.7fr) minmax(7rem, 1fr) minmax(5rem, .8fr) minmax(5rem, .7fr)',
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
  rowPrimary: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  rowSecondary: { color: explorerTokens['muted-text'], whiteSpace: 'nowrap' },
  mono: { fontFamily: explorerTokens['font-data'], fontVariantNumeric: 'tabular-nums' },
  status: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: explorerTokens['density-block'],
    fontWeight: 600,
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

const StatusBadge = ({ state }: { state: RecordState }): React.ReactNode => {
  const status = statusByState[state]
  return (
    <span
      aria-label={`Lifecycle: ${status.label}`}
      {...stylex.props(styles.status, toneStyle[status.tone])}
    >
      <span aria-hidden="true">{status.symbol}</span>
      {status.label}
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
  readonly state: 'all' | 'active' | 'completed' | RecordState
  readonly side: 'all' | RequestIdentity['observerSide']
  readonly direction: 'all' | RequestIdentity['direction']
  readonly descriptor: 'all' | string
}

interface ExplorerInitialFilters {
  readonly search?: string
  readonly state?: Filters['state']
  readonly side?: Filters['side']
  readonly direction?: Filters['direction']
  readonly descriptor?: Filters['descriptor']
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
  if (
    filters.state !== 'all' &&
    filters.state !== 'active' &&
    filters.state !== 'completed' &&
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
}: {
  record: RpcRecord
  descriptor: RpcDescriptorWire | undefined
  nowMillis: number
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
      {...stylex.props(styles.row)}
    >
      <span {...stylex.props(styles.rowPrimary, styles.mono)} title={descriptorName(descriptor)}>
        {descriptorName(descriptor)}
      </span>
      <span {...stylex.props(styles.rowSecondary)}>
        <span aria-hidden="true">{record.key.direction === 'clientToServer' ? '→' : '←'} </span>
        {record.key.observerSide} · {direction}
      </span>
      <StatusBadge state={record.state} />
      <span {...stylex.props(styles.rowSecondary, styles.mono)}>
        started {formatDuration(nowMillis - record.startedAt.wallClockMillis)} ago ·{' '}
        {formatDuration(durationEnd - record.startedAt.wallClockMillis)} · {record.chunkEnvelopes}/
        {record.streamValues}
        {retainedMarker} · {record.trace === undefined ? 'no trace' : 'trace linked'}
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

/** Dense, transport-neutral Effect RPC diagnostic explorer. */
const RpcExplorer = ({
  client,
  initialFilters,
  presentation,
}: RpcExplorerProps): React.ReactNode => {
  const store = React.useMemo(() => createExplorerProjectionStore(client), [client])
  const projection = useProjection(store)
  const [filters, setFilters] = React.useState<Filters>({
    search: initialFilters?.search ?? '',
    state: initialFilters?.state ?? 'all',
    side: initialFilters?.side ?? 'all',
    direction: initialFilters?.direction ?? 'all',
    descriptor: initialFilters?.descriptor ?? 'all',
  })
  const [selectedKey, setSelectedKey] = React.useState<string | undefined>(undefined)
  const [narrowDetail, setNarrowDetail] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const listRef = React.useRef<HTMLDivElement>(null)
  const originatingRowId = React.useRef<string | undefined>(undefined)
  const priorRecordKeys = React.useRef<ReadonlySet<string>>(new Set())

  const active = [...projection.active.values()].filter((record) =>
    recordMatches({
      record,
      descriptor: projection.descriptors.get(record.descriptorId),
      bucket: 'active',
      filters,
    }),
  )
  const completed = [...projection.completed.values()].filter((record) =>
    recordMatches({
      record,
      descriptor: projection.descriptors.get(record.descriptorId),
      bucket: 'completed',
      filters,
    }),
  )
  const allRecords = React.useMemo(
    () => new Map([...projection.active, ...projection.completed]),
    [projection.active, projection.completed],
  )
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
  const forceNarrow = presentation?.layout === 'narrow'
  const forceWide = presentation?.layout === 'wide'
  const listVisibility =
    forceNarrow === true
      ? narrowDetail === true
        ? styles.hidden
        : undefined
      : forceWide === true
        ? undefined
        : narrowDetail === true
          ? styles.hiddenAtNarrow
          : undefined
  const detailVisibility =
    forceNarrow === true
      ? narrowDetail === true
        ? undefined
        : styles.hidden
      : forceWide === true
        ? undefined
        : narrowDetail === true
          ? undefined
          : styles.hiddenAtNarrow

  return (
    <main
      {...stylex.props(styles.root, presentation?.style)}
      data-layout={presentation?.layout ?? 'auto'}
    >
      <header {...stylex.props(styles.toolbar)}>
        <div {...stylex.props(styles.toolbarSummary)}>
          <span {...stylex.props(styles.productName)}>RPC Explorer</span>
          <span {...stylex.props(styles.metadata)}>
            {projection.active.size} active · {projection.completed.size} completed · rev{' '}
            {projection.revision ?? '—'}
          </span>
          <span {...stylex.props(styles.metadata)}>{connectionText(projection)}</span>
          {projection.resetReason === undefined ? undefined : (
            <span {...stylex.props(styles.metadata)}>Last reset: {projection.resetReason}</span>
          )}
          {projection.counters.completedEvicted + projection.counters.activeEvicted > 0 ? (
            <span {...stylex.props(styles.metadata)}>
              {projection.counters.completedEvicted + projection.counters.activeEvicted} records
              expired by retention
            </span>
          ) : undefined}
        </div>
        <TextField
          value={filters.search}
          onChange={(search) => setFilters((current) => ({ ...current, search }))}
          {...stylex.props(styles.field)}
        >
          <Label {...stylex.props(styles.label)}>Filter key, tag, or status</Label>
          <Input {...stylex.props(styles.input)} placeholder="Filter records" />
        </TextField>
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
            setFilters((current) => ({ ...current, direction: direction as Filters['direction'] }))
          }
        />
        <SelectFilter
          label="Descriptor"
          value={filters.descriptor}
          options={descriptorOptions}
          onChange={(descriptor) => setFilters((current) => ({ ...current, descriptor }))}
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
                        This removes completed explorer history while keeping active observed calls
                        correlatable. It does not cancel, retry, or otherwise affect application
                        RPCs.
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
      </header>
      <div
        {...stylex.props(
          styles.split,
          forceNarrow === true ? styles.forceNarrowSplit : undefined,
          forceWide === true ? styles.forceWideSplit : undefined,
        )}
      >
        <section
          aria-label="RPC records"
          {...stylex.props(
            styles.listPane,
            forceNarrow === true ? styles.forceNarrowListPane : undefined,
            forceWide === true ? styles.forceWideListPane : undefined,
            listVisibility,
          )}
        >
          <div {...stylex.props(styles.sectionHeader)}>
            {active.length + completed.length} matching records
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
                      />
                    )}
                  </Collection>
                </ListBoxSection>
              )}
            </ListBox>
          </Virtualizer>
          {active.length + completed.length === 0 ? (
            <p {...stylex.props(styles.empty)}>No records match the current filters.</p>
          ) : undefined}
        </section>
        <section
          aria-label="Selected RPC record"
          {...stylex.props(
            styles.detailPane,
            forceNarrow === true ? styles.forceNarrowDetailPane : undefined,
            forceWide === true ? styles.forceWideDetailPane : undefined,
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
              backVisibility={
                forceNarrow === true ? 'always' : forceWide === true ? 'never' : 'auto'
              }
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
