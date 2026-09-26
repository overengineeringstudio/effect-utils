import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import {
  Button,
  Heading,
  Tab,
  Link,
  TabList,
  TabPanel,
  Tabs,
  Tooltip,
  TooltipTrigger,
} from 'react-aria-components'

import type {
  CaptureChannel,
  ChannelObservation,
  ExplorerEvent,
  RecordState,
  RpcDescriptorWire,
  RpcRecord,
} from '@overeng/effect-rpc-explorer'
import { fontSizes, spacing } from '@overeng/stylex-tokens/tokens.stylex'

import { ChannelContentPanel, channelLabel } from './ChannelContentPanel.tsx'
import type { ExplorerProjection } from './projection.ts'
import { SchemaTree } from './SchemaTree.tsx'
import { explorerTokens } from './tokens.stylex.ts'
import {
  activeStates,
  descriptorName,
  formatDuration,
  identityText,
  statusByState,
  type StatusTone,
} from './view-model.ts'

/** Typed inputs for the selected-record detail surface. */
export type { TraceHref }
export type { RpcRecordDetailProps }
/** Selected-record detail with summary, timeline, content, descriptor, and trace tabs. */
export { RpcRecordDetail }

const styles = stylex.create({
  button: {
    minHeight: explorerTokens['control-height'],
    paddingInline: explorerTokens['density-inline'],
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
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  detailHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 2,
    display: 'flex',
    flexWrap: { default: 'nowrap', '@media (max-width: 63.99rem)': 'wrap' },
    alignItems: 'center',
    gap: explorerTokens['density-gap'],
    padding: explorerTokens['density-gap'],
    backgroundColor: explorerTokens['panel-raised'],
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: explorerTokens.border,
  },
  detailIdentity: { display: 'grid', flexGrow: 1, minWidth: 0, gap: spacing['0.5'] },
  detailTitle: {
    minWidth: 0,
    margin: 0,
    fontSize: fontSizes.sm,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  detailSummary: {
    margin: 0,
    color: explorerTokens['muted-text'],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deprecated: {
    paddingInline: explorerTokens['density-inline'],
    color: explorerTokens.warning,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.warning,
    fontWeight: 600,
  },
  back: {
    display: { default: 'none', '@media (max-width: 63.99rem)': 'inline-flex' },
    alignItems: 'center',
    columnGap: explorerTokens['density-block'],
  },
  hidden: { display: 'none' },
  visible: { display: 'inline-flex' },
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
  tabs: { display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', minHeight: 0 },
  tabList: {
    display: 'flex',
    overflowX: 'auto',
    backgroundColor: explorerTokens.panel,
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: explorerTokens.border,
  },
  tab: {
    paddingInline: spacing[3],
    paddingBlock: explorerTokens['density-gap'],
    borderBlockEndWidth: 2,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: { default: 'transparent', '[data-selected]': explorerTokens.info },
    color: { default: explorerTokens['muted-text'], '[data-selected]': explorerTokens.text },
    cursor: 'pointer',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  tabPanel: { padding: spacing[3], outline: 'none' },
  propertyGrid: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    columnGap: spacing[4],
    rowGap: explorerTokens['density-block'],
    margin: 0,
  },
  term: { color: explorerTokens['muted-text'], fontWeight: 500 },
  definition: {
    minWidth: 0,
    margin: 0,
    overflowWrap: 'anywhere',
    fontFamily: explorerTokens['font-data'],
  },
  stack: { display: 'grid', gap: explorerTokens['density-gap'] },
  traceLink: {
    color: explorerTokens.info,
    textDecoration: 'underline',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
  empty: { padding: spacing[4], color: explorerTokens['muted-text'] },
  timeline: { display: 'grid', gap: 0, margin: 0, padding: 0, listStyle: 'none' },
  timelineItem: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 6rem) minmax(0, 1fr) auto',
    gap: explorerTokens['density-gap'],
    paddingBlock: explorerTokens['density-block'],
    borderBlockEndWidth: 1,
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: explorerTokens.border,
  },
  mono: { fontFamily: explorerTokens['font-data'], fontVariantNumeric: 'tabular-nums' },
  metadata: { color: explorerTokens['muted-text'], fontVariantNumeric: 'tabular-nums' },
  warningBox: {
    padding: explorerTokens['density-gap'],
    borderInlineStartWidth: 2,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: explorerTokens.warning,
    backgroundColor: explorerTokens.panel,
    color: explorerTokens.warning,
  },
  tooltip: {
    paddingInline: explorerTokens['density-inline'],
    paddingBlock: explorerTokens['density-block'],
    backgroundColor: explorerTokens['panel-raised'],
    color: explorerTokens.text,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.border,
    fontSize: explorerTokens['font-size'],
  },
})

const toneStyle: Record<StatusTone, stylex.StyleXStyles> = {
  success: styles.success,
  failure: styles.failure,
  warning: styles.warning,
  fault: styles.fault,
  info: styles.info,
}

const StatusBadge = ({ state }: { state: RecordState }): ReactNode => {
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

const observationsForEvent = (event: ExplorerEvent): ReadonlyArray<ChannelObservation> => {
  if (event._tag === 'RequestObserved' || event._tag === 'TerminalObserved')
    return event.observations
  if (event._tag === 'ChunkObserved') return event.values
  return []
}

const eventsForRecord = ({
  record,
  projection,
}: {
  readonly record: RpcRecord
  readonly projection: ExplorerProjection
}): ReadonlyArray<ExplorerEvent> =>
  record.events.flatMap((eventId) => {
    const event = projection.events.get(eventId)
    return event === undefined ? [] : [event]
  })

const Property = ({ label, children }: { label: string; children: ReactNode }): ReactNode => (
  <>
    <dt {...stylex.props(styles.term)}>{label}</dt>
    <dd {...stylex.props(styles.definition)}>{children}</dd>
  </>
)

const RecordSummary = ({
  record,
  nowMillis,
}: {
  record: RpcRecord
  nowMillis: number
}): ReactNode => {
  const end = activeStates.has(record.state) === true ? nowMillis : record.lastAt.wallClockMillis
  return (
    <div {...stylex.props(styles.stack)}>
      <dl {...stylex.props(styles.propertyGrid)}>
        <Property label="Lifecycle">
          <StatusBadge state={record.state} />
        </Property>
        <Property label="Identity">{identityText(record.key)}</Property>
        <Property label="Notification">
          {record.notification === true ? 'Yes — no terminal response expected' : 'No'}
        </Property>
        <Property label="Send fact">{record.send}</Property>
        <Property label="Duration">
          {formatDuration(end - record.startedAt.wallClockMillis)}
        </Property>
        <Property label="Stream">
          {record.chunkEnvelopes} envelopes / {record.streamValues} values
        </Property>
        <Property label="Retained values">
          {record.retainedStreamValues} of {record.streamValues}
        </Property>
      </dl>
      {record.state === 'uncertain' ? (
        <div {...stylex.props(styles.warningBox)}>
          Protocol attribution is unavailable. This record is uncertain because a connection fault
          affected an active call; no request-level application error is inferred.
        </div>
      ) : undefined}
      {record.evidence.map((evidence) => (
        <div key={JSON.stringify(evidence)} {...stylex.props(styles.warningBox)}>
          {evidence._tag === 'ConnectionFault'
            ? `Connection fault ${evidence.faultId}: ${evidence.fault}`
            : evidence._tag === 'ValuesTruncated'
              ? `${evidence.count} stream values expired from bounded retention`
              : evidence._tag === 'RetentionExpired'
                ? `Retention evidence: ${evidence.reason}`
                : evidence._tag === 'UnknownDescriptor'
                  ? 'Unknown descriptor observed; no RPC identity was inferred'
                  : 'Late terminal event retained as an anomaly'}
        </div>
      ))}
    </div>
  )
}

const LifecycleTimeline = ({
  record,
  events,
}: {
  record: RpcRecord
  events: ReadonlyArray<ExplorerEvent>
}): ReactNode => {
  const startNanos = (() => {
    try {
      return BigInt(record.startedAt.monotonicNanos)
    } catch {
      return 0n
    }
  })()
  return events.length === 0 ? (
    <p {...stylex.props(styles.empty)}>No retained events.</p>
  ) : (
    <ol {...stylex.props(styles.timeline)}>
      {events.map((event) => {
        let relative = 'order unavailable'
        try {
          relative = `+${formatDuration(Number(BigInt(event.at.monotonicNanos) - startNanos) / 1_000_000)}`
        } catch {
          /* bounded wire string was not numeric */
        }
        return (
          <li key={event.eventId} {...stylex.props(styles.timelineItem)}>
            <time
              dateTime={new Date(event.at.wallClockMillis).toISOString()}
              {...stylex.props(styles.mono)}
            >
              {new Date(event.at.wallClockMillis).toISOString().slice(11, 23)}
            </time>
            <span>{event._tag}</span>
            <span {...stylex.props(styles.metadata)}>{relative}</span>
          </li>
        )
      })}
    </ol>
  )
}

const ContentDetail = ({
  events,
  descriptor,
}: {
  events: ReadonlyArray<ExplorerEvent>
  descriptor: RpcDescriptorWire | undefined
}): ReactNode => {
  const observations = events.flatMap(observationsForEvent)
  const grouped = new Map<CaptureChannel, Array<ChannelObservation>>()
  for (const observation of observations) {
    const existing = grouped.get(observation.channel)
    if (existing === undefined) grouped.set(observation.channel, [observation])
    else existing.push(observation)
  }
  return observations.length === 0 ? (
    <p {...stylex.props(styles.empty)}>No channel observations retained.</p>
  ) : (
    <div {...stylex.props(styles.stack)}>
      {[...grouped.entries()].flatMap(([channel, channelObservations]) =>
        channelObservations.map((observation) => (
          <ChannelContentPanel
            key={`${channel}-${JSON.stringify(observation)}`}
            observation={observation}
            schema={descriptor?.channels[channel].schema}
          />
        )),
      )}
    </div>
  )
}

const CopyIdentifier = ({ label, value }: { label: string; value: string }): ReactNode => (
  <TooltipTrigger>
    <Button
      aria-label={`Copy ${label}`}
      {...stylex.props(styles.button)}
      onPress={() => void navigator.clipboard.writeText(value)}
    >
      Copy {label}
    </Button>
    <Tooltip {...stylex.props(styles.tooltip)}>Copies this safe structured identifier.</Tooltip>
  </TooltipTrigger>
)

const DescriptorPanel = ({
  descriptor,
}: {
  descriptor: RpcDescriptorWire | undefined
}): ReactNode => {
  if (descriptor === undefined)
    return (
      <p {...stylex.props(styles.warningBox)}>Descriptor unavailable for this observed identity.</p>
    )
  const channels: ReadonlyArray<
    readonly [CaptureChannel | 'terminal', RpcDescriptorWire['terminal']]
  > = [
    ...(Object.entries(descriptor.channels) as ReadonlyArray<
      readonly [CaptureChannel, RpcDescriptorWire['channels'][CaptureChannel]]
    >),
    ['terminal', descriptor.terminal],
  ]
  return (
    <div {...stylex.props(styles.stack)}>
      {descriptor.description === undefined ? undefined : <p>{descriptor.description}</p>}
      <dl {...stylex.props(styles.propertyGrid)}>
        <Property label="Key">{descriptor.key}</Property>
        <Property label="Tag">{descriptor.tag}</Property>
        <Property label="Kind">{descriptor.kind}</Property>
        <Property label="Observation">{descriptor.observe}</Property>
      </dl>
      <CopyIdentifier label="descriptor key" value={descriptor.key} />
      {channels
        .filter(
          ([, projection]) =>
            projection.projection === 'unavailable' ||
            projection.schema !== undefined ||
            projection.warning !== undefined,
        )
        .map(([channel, projection]) => (
          <section key={channel}>
            <Heading level={4}>
              {channel === 'terminal' ? 'Terminal' : channelLabel[channel]}
            </Heading>
            {projection.projection === 'unavailable' ? (
              <p {...stylex.props(styles.warningBox)}>
                Schema projection unavailable
                {projection.warning === undefined ? '.' : `: ${projection.warning}`}
              </p>
            ) : (
              <SchemaTree document={projection.schema} />
            )}
          </section>
        ))}
    </div>
  )
}

type TraceHref = (trace: {
  readonly traceId: string
  readonly spanId?: string | undefined
}) => string | undefined

const TracePanel = ({
  record,
  traceHref,
}: {
  record: RpcRecord
  traceHref?: TraceHref | undefined
}): ReactNode => {
  if (record.trace === undefined) {
    return <p {...stylex.props(styles.empty)}>No trace context observed</p>
  }
  const href = traceHref?.(record.trace)
  return (
    <div {...stylex.props(styles.stack)}>
      <dl {...stylex.props(styles.propertyGrid)}>
        <Property label="Trace ID">
          {href === undefined ? (
            record.trace.traceId
          ) : (
            <Link href={href} target="_blank" rel="noreferrer" {...stylex.props(styles.traceLink)}>
              {record.trace.traceId}
            </Link>
          )}
        </Property>
        <Property label="Span ID">{record.trace.spanId ?? 'Not observed'}</Property>
        <Property label="Sampled">
          {record.trace.sampled === undefined ? 'Not observed' : String(record.trace.sampled)}
        </Property>
      </dl>
      <div>
        <CopyIdentifier label="trace ID" value={record.trace.traceId} />{' '}
        {record.trace.spanId === undefined ? undefined : (
          <CopyIdentifier label="span ID" value={record.trace.spanId} />
        )}
      </div>
    </div>
  )
}

interface RpcRecordDetailProps {
  readonly record: RpcRecord
  readonly descriptor: RpcDescriptorWire | undefined
  readonly projection: ExplorerProjection
  readonly nowMillis: number
  readonly onBack: () => void
  readonly traceHref?: TraceHref | undefined
  readonly backVisibility: 'auto' | 'always' | 'never'
}

const RpcRecordDetail = ({
  record,
  descriptor,
  projection,
  nowMillis,
  onBack,
  backVisibility,
  traceHref,
}: RpcRecordDetailProps): ReactNode => {
  const events = eventsForRecord({ record, projection })
  return (
    <article aria-labelledby="rpc-explorer-detail-title">
      <header {...stylex.props(styles.detailHeader)}>
        <Button
          {...stylex.props(
            styles.button,
            styles.back,
            backVisibility === 'always' ? styles.visible : undefined,
            backVisibility === 'never' ? styles.hidden : undefined,
          )}
          onPress={onBack}
        >
          <span aria-hidden="true">←</span>Back to records
        </Button>
        <div {...stylex.props(styles.detailIdentity)}>
          <Heading id="rpc-explorer-detail-title" level={2} {...stylex.props(styles.detailTitle)}>
            {descriptor?.title ?? descriptorName(descriptor)}
          </Heading>
          {descriptor?.summary === undefined ? undefined : (
            <p {...stylex.props(styles.detailSummary)} title={descriptor.summary}>
              {descriptor.summary}
            </p>
          )}
        </div>
        {descriptor?.deprecated === true ? (
          <span {...stylex.props(styles.deprecated)}>Deprecated</span>
        ) : undefined}
        <StatusBadge state={record.state} />
        <CopyIdentifier label="request identity" value={identityText(record.key)} />
      </header>
      <Tabs defaultSelectedKey="summary" {...stylex.props(styles.tabs)}>
        <TabList aria-label="Record details" {...stylex.props(styles.tabList)}>
          <Tab id="summary" {...stylex.props(styles.tab)}>
            Summary
          </Tab>
          <Tab id="timeline" {...stylex.props(styles.tab)}>
            Timeline
          </Tab>
          <Tab id="content" {...stylex.props(styles.tab)}>
            Content
          </Tab>
          <Tab id="descriptor" {...stylex.props(styles.tab)}>
            Descriptor
          </Tab>
          <Tab id="trace" {...stylex.props(styles.tab)}>
            Trace
          </Tab>
        </TabList>
        <TabPanel id="summary" {...stylex.props(styles.tabPanel)}>
          <RecordSummary record={record} nowMillis={nowMillis} />
        </TabPanel>
        <TabPanel id="timeline" {...stylex.props(styles.tabPanel)}>
          <LifecycleTimeline record={record} events={events} />
        </TabPanel>
        <TabPanel id="content" {...stylex.props(styles.tabPanel)}>
          <ContentDetail events={events} descriptor={descriptor} />
        </TabPanel>
        <TabPanel id="descriptor" {...stylex.props(styles.tabPanel)}>
          <DescriptorPanel descriptor={descriptor} />
        </TabPanel>
        <TabPanel id="trace" {...stylex.props(styles.tabPanel)}>
          <TracePanel record={record} traceHref={traceHref} />
        </TabPanel>
      </Tabs>
    </article>
  )
}
