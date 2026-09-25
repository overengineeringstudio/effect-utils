import * as stylex from '@stylexjs/stylex'
import type { ReactNode } from 'react'
import { Button, Disclosure, DisclosurePanel, Heading } from 'react-aria-components'

import type { ChannelObservation, NormalizedValue } from '@overeng/effect-rpc-explorer'
import { spacing } from '@overeng/stylex-tokens/tokens.stylex'

import { normalizedValueText } from './normalized-value.ts'
import { explorerTokens } from './tokens.stylex.ts'

/** Inputs for rendering one policy-governed capture channel. */
export type { ChannelContentPanelProps }
/** Safe normalized channel renderer and text serializer. */
export { ChannelContentPanel }
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

const NormalizedNode = ({
  value,
  label,
}: {
  value: NormalizedValue
  label?: string
}): ReactNode => {
  const prefix =
    label === undefined ? undefined : <span {...stylex.props(styles.key)}>{label}: </span>

  if (value._tag === 'Array' || value._tag === 'Object') {
    const entries: ReadonlyArray<readonly [string, NormalizedValue]> =
      value._tag === 'Array'
        ? value.value.map((child, index) => [String(index), child] as const)
        : Object.entries(value.value)
    const summary =
      value._tag === 'Array' ? `Array(${entries.length})` : `Object(${entries.length})`
    return (
      <Disclosure defaultExpanded>
        <Button slot="trigger" {...stylex.props(styles.disclosureButton)}>
          <span aria-hidden="true">▾</span>
          {prefix}
          {summary}
        </Button>
        <DisclosurePanel>
          <ul {...stylex.props(styles.tree)}>
            {entries.map(([key, child]) => (
              <li key={key} {...stylex.props(styles.row)}>
                <NormalizedNode value={child} label={key} />
              </li>
            ))}
          </ul>
        </DisclosurePanel>
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
  readonly style?: stylex.StyleXStyles
}

/** Renders one policy-governed channel without accepting or inspecting unknown live values. */
const ChannelContentPanel = ({ observation, style }: ChannelContentPanelProps): ReactNode => {
  const title = channelLabel[observation.channel]

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
  return (
    <section {...stylex.props(styles.panel, style)}>
      <Heading level={4} {...stylex.props(styles.heading)}>
        {title}
      </Heading>
      <span {...stylex.props(styles.legend)}>
        {outcome.mode === 'redact' ? 'Redacted projection' : 'Captured'} — {outcome.source} policy
      </span>
      <NormalizedNode value={value} />
      {mayCopy === true ? (
        <Button
          aria-label={`Copy rendered ${title.toLowerCase()}`}
          {...stylex.props(styles.copyButton)}
          onPress={() => void navigator.clipboard.writeText(normalizedValueText(value))}
        >
          Copy rendered value
        </Button>
      ) : undefined}
    </section>
  )
}
