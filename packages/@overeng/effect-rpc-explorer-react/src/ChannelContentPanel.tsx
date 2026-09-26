import * as stylex from '@stylexjs/stylex'
import { useState, type ReactNode } from 'react'
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components'

import type { ChannelObservation, NormalizedValue } from '@overeng/effect-rpc-explorer'
import { spacing } from '@overeng/stylex-tokens/tokens.stylex'

import { normalizedValueText } from './normalized-value.ts'
import { schemaFieldMetadata, type SchemaFieldMetadata } from './schema-field.ts'
import { explorerTokens } from './tokens.stylex.ts'

/** Inputs for rendering one policy-governed capture channel. */
export type { ChannelContentPanelProps }
/** Safe normalized channel renderer and text serializer. */
export { ChannelContentPanel }
/** Human-readable names shared by captured content and descriptor schemas. */
export { channelLabel }
export { normalizedValueText } from './normalized-value.ts'

const styles = stylex.create({
  panel: {
    display: 'grid',
    rowGap: explorerTokens['density-block'],
    padding: explorerTokens['density-gap'],
    backgroundColor: explorerTokens.panel,
    borderInlineStartWidth: 2,
    borderInlineStartStyle: 'solid',
    borderInlineStartColor: explorerTokens.border,
  },
  heading: {
    margin: 0,
    color: explorerTokens.text,
    fontSize: explorerTokens['font-size'],
    fontWeight: 600,
  },
  legend: {
    color: explorerTokens['muted-text'],
    fontSize: explorerTokens['font-size'],
  },
  fault: { color: explorerTokens.fault },
  warning: { color: explorerTokens.warning },
  tree: {
    display: 'grid',
    rowGap: spacing['0.5'],
    margin: 0,
    listStyle: 'none',
    paddingInlineStart: spacing[3],
    color: explorerTokens.text,
    fontFamily: explorerTokens['font-data'],
    fontSize: explorerTokens['font-size'],
    lineHeight: 1.4,
  },
  row: { minWidth: 0 },
  key: { color: explorerTokens['muted-text'] },
  value: { overflowWrap: 'anywhere' },
  fieldNote: {
    marginBlock: explorerTokens['density-block'],
    color: explorerTokens['muted-text'],
    overflowWrap: 'anywhere',
  },
  disclosureButton: {
    display: 'inline-flex',
    alignItems: 'center',
    columnGap: explorerTokens['density-block'],
    padding: 0,
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: explorerTokens.text,
    font: 'inherit',
    cursor: 'pointer',
    outline: {
      default: 'none',
      '[data-focus-visible]': `1px solid ${explorerTokens['focus-ring']}`,
    },
  },
  copyActions: { display: 'flex', flexWrap: 'wrap', gap: explorerTokens['density-gap'] },
  copyButton: {
    justifySelf: 'start',
    minHeight: explorerTokens['control-height'],
    paddingInline: explorerTokens['density-gap'],
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: explorerTokens.border,
    backgroundColor: {
      default: explorerTokens['panel-raised'],
      '[data-hovered]': explorerTokens.panel,
    },
    color: explorerTokens.text,
    fontSize: explorerTokens['font-size'],
    cursor: 'pointer',
    outline: {
      default: 'none',
      '[data-focus-visible]': `2px solid ${explorerTokens['focus-ring']}`,
    },
  },
})

const emptyPath: ReadonlyArray<string> = []

const FieldAnnotation = ({
  label,
  metadata,
}: {
  label: string
  metadata: SchemaFieldMetadata | undefined
}): ReactNode => {
  if (
    metadata === undefined ||
    (metadata.description === undefined &&
      metadata.examples.length === 0 &&
      metadata.required === undefined)
  )
    return undefined
  return (
    <Disclosure>
      <Button
        slot="trigger"
        aria-label={`Schema notes for ${label}`}
        {...stylex.props(styles.disclosureButton, styles.key)}
      >
        About {label}
      </Button>
      <DisclosurePanel>
        <div {...stylex.props(styles.fieldNote)}>
          {metadata.required === undefined ? undefined : (
            <div>{metadata.required === true ? 'Required field' : 'Optional field'}</div>
          )}
          {metadata.description === undefined ? undefined : <div>{metadata.description}</div>}
          {metadata.examples.length === 0 ? undefined : (
            <div>
              Example: {metadata.examples.map((example) => JSON.stringify(example)).join(', ')}
            </div>
          )}
        </div>
      </DisclosurePanel>
    </Disclosure>
  )
}

const NormalizedNode = ({
  value,
  label,
  schema,
  path = emptyPath,
}: {
  value: NormalizedValue
  label?: string
  schema?: unknown
  path?: ReadonlyArray<string>
}): ReactNode => {
  const prefix =
    label === undefined ? undefined : <span {...stylex.props(styles.key)}>{label}: </span>
  const rootTitle =
    path.length === 0 ? schemaFieldMetadata({ document: schema, path })?.title : undefined

  if (value._tag === 'Array' || value._tag === 'Object') {
    const entries: ReadonlyArray<readonly [string, NormalizedValue]> =
      value._tag === 'Array'
        ? value.value.map((child, index) => [String(index), child] as const)
        : Object.entries(value.value)
    const summary =
      rootTitle === undefined
        ? value._tag === 'Array'
          ? `Array(${entries.length})`
          : `Object(${entries.length})`
        : `${value._tag === 'Array' ? 'array' : 'object'} · ${entries.length} ${value._tag === 'Array' ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'field' : 'fields'}`
    return (
      <Disclosure defaultExpanded>
        {({ isExpanded }) => (
          <>
            <Button slot="trigger" {...stylex.props(styles.disclosureButton)}>
              <span aria-hidden="true">{isExpanded === true ? '▾' : '▸'}</span>
              {prefix}
              {rootTitle === undefined ? '' : `${rootTitle} · `}
              {summary}
            </Button>
            <DisclosurePanel>
              <ul {...stylex.props(styles.tree)}>
                {entries.map(([key, child]) => {
                  const childPath = [...path, key]
                  const annotation = schemaFieldMetadata({ document: schema, path: childPath })
                  const childLabel = annotation?.title ?? key
                  return (
                    <li key={key} {...stylex.props(styles.row)}>
                      <NormalizedNode
                        value={child}
                        label={childLabel}
                        schema={schema}
                        path={childPath}
                      />
                      <FieldAnnotation label={childLabel} metadata={annotation} />
                    </li>
                  )
                })}
              </ul>
            </DisclosurePanel>
          </>
        )}
      </Disclosure>
    )
  }

  if (value._tag === 'Redacted') {
    return <span {...stylex.props(styles.warning)}>{prefix}Redacted value</span>
  }
  if (value._tag === 'Unsupported') {
    return (
      <span {...stylex.props(styles.warning)}>
        {prefix}Unsupported value type: {value.type}
      </span>
    )
  }
  if (value._tag === 'Truncated') {
    return (
      <div>
        <span {...stylex.props(styles.warning)}>
          {prefix}Value truncated: {value.reason}
        </span>
        {value.retained === undefined ? undefined : (
          <div {...stylex.props(styles.tree)}>
            <NormalizedNode value={value.retained} label="retained" />
          </div>
        )}
      </div>
    )
  }

  return (
    <span {...stylex.props(styles.value)}>
      {prefix}
      {normalizedValueText(value)}
    </span>
  )
}

const channelLabel: Record<ChannelObservation['channel'], string> = {
  requestPayload: 'Request payload',
  success: 'Success',
  typedFailure: 'Typed failure',
  defect: 'Defect',
  streamElement: 'Stream element',
  streamError: 'Stream error',
  headers: 'Headers',
}

interface ChannelContentPanelProps {
  readonly observation: ChannelObservation
  readonly schema?: unknown
  readonly style?: stylex.StyleXStyles
}

/** Renders one policy-governed channel without accepting or inspecting unknown live values. */
const ChannelContentPanel = ({
  observation,
  schema,
  style,
}: ChannelContentPanelProps): ReactNode => {
  const title = channelLabel[observation.channel]
  const [copyStatus, setCopyStatus] = useState('')

  if ('captured' in observation === false) {
    const { outcome } = observation
    return (
      <section {...stylex.props(styles.panel, style)}>
        <Heading level={4} {...stylex.props(styles.heading)}>
          {title}
        </Heading>
        {outcome._tag === 'Omitted' ? (
          <span {...stylex.props(styles.legend)}>Not captured — {outcome.source} policy</span>
        ) : (
          <span {...stylex.props(styles.legend, styles.fault)}>
            Not captured — capture policy fault ({outcome.fault})
          </span>
        )}
      </section>
    )
  }

  const { outcome, captured: value } = observation
  const mayCopy = value._tag !== 'Redacted'
  const rootDescription = schemaFieldMetadata({ document: schema, path: emptyPath })?.description
  const copy = (format: 'text' | 'json'): void => {
    if (navigator.clipboard === undefined) {
      setCopyStatus('Clipboard unavailable')
      return
    }
    const content = format === 'json' ? JSON.stringify(value, null, 2) : normalizedValueText(value)
    void navigator.clipboard.writeText(content).then(
      () => setCopyStatus(`Copied normalized ${format === 'json' ? 'JSON' : 'text'}`),
      () => setCopyStatus('Copy failed — check clipboard permissions'),
    )
  }
  return (
    <section {...stylex.props(styles.panel, style)}>
      <Heading level={4} {...stylex.props(styles.heading)}>
        {title}
      </Heading>
      <span {...stylex.props(styles.legend)}>
        {outcome.mode === 'redact' ? 'Redacted projection' : 'Captured'} — {outcome.source} policy
      </span>
      {rootDescription === undefined ? undefined : (
        <span {...stylex.props(styles.legend)}>{rootDescription}</span>
      )}
      <NormalizedNode value={value} schema={schema} />
      {mayCopy === true ? (
        <div {...stylex.props(styles.copyActions)}>
          <Button {...stylex.props(styles.copyButton)} onPress={() => copy('text')}>
            Copy normalized text
          </Button>
          <Button {...stylex.props(styles.copyButton)} onPress={() => copy('json')}>
            Copy normalized JSON
          </Button>
        </div>
      ) : undefined}
      {copyStatus === '' ? undefined : (
        <span role="status" {...stylex.props(styles.legend)}>
          {copyStatus}
        </span>
      )}
    </section>
  )
}
