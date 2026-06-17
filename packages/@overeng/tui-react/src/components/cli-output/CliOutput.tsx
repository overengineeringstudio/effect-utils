/**
 * `/sk-cli-design` output kit — presentational components that render the
 * shared CLI-output vocabulary (problems-first structure, severity badges,
 * status symbols, truncation, dimmed summary line) through the active
 * OutputMode seam.
 *
 * All glyph/color choices flow through `useSymbols()` / `useRenderConfig()`,
 * so unicode/ascii fallback (`NO_UNICODE`) and color/no-color are honored
 * automatically — callers route output through here instead of writing raw
 * strings.
 *
 * @module
 */

import { isValidElement, type ReactNode } from 'react'

import { useRenderConfig } from '../../effect/OutputMode.tsx'
import { useSymbols } from '../../hooks/useSymbols.tsx'
import { Box } from '../Box.tsx'
import { TaskList, type TaskItem } from '../TaskList.tsx'
import { Text } from '../Text.tsx'
import type { DetailSection, ProblemItem, Severity, StatusSymbol } from './schema.ts'

// =============================================================================
// SeverityBadge
// =============================================================================

/** Props for {@link SeverityBadge}. */
export interface SeverityBadgeProps {
  /** Severity to render. */
  readonly severity: Severity
}

/**
 * Severity badge: `CRITICAL` (bold white-on-red) or `WARNING`
 * (bold black-on-yellow). Colors are emitted only when the active
 * RenderConfig has colors enabled.
 */
export const SeverityBadge = ({ severity }: SeverityBadgeProps): ReactNode =>
  severity === 'critical' ? (
    <Text bold backgroundColor="red" color="white">
      CRITICAL
    </Text>
  ) : (
    <Text bold backgroundColor="yellow" color="black">
      WARNING
    </Text>
  )

// =============================================================================
// ProblemList
// =============================================================================

/** Props for {@link ProblemList}. */
export interface ProblemListProps {
  /** Problems to render (1 blank line between items). */
  readonly items: readonly ProblemItem[]
}

/**
 * Renders a list of problem items with `fix:`/`skip:` affordances.
 *
 * Each item: bold name, dimmed status/details, optional dimmed context line,
 * cyan `fix:` lines, dimmed `skip:` lines. A blank line separates items.
 * Renders nothing when `items` is empty.
 */
export const ProblemList = ({ items }: ProblemListProps): ReactNode => {
  if (items.length === 0) return null

  return stackWithBlankLines(
    items.map((item, index) => (
      <ProblemEntry key={`${index}:${item.severity}:${item.name}`} item={item} />
    )),
  )
}

// =============================================================================
// DetailSections
// =============================================================================

/** Props for {@link DetailSections}. */
export interface DetailSectionsProps {
  /** Sections to render. Empty sections are omitted. */
  readonly sections: readonly DetailSection[]
}

/**
 * Renders titled detail sections: `title(count):` header, up to 5 items,
 * dimmed `+ N more` when truncated. Sections with no items and no `more`
 * are omitted; renders nothing when all sections are empty.
 */
export const DetailSections = ({ sections }: DetailSectionsProps): ReactNode => {
  const visible = sections.filter((section) => isSectionVisible(section) === true)
  if (visible.length === 0) return null

  return (
    <Box>
      {visible.map((section) => (
        <DetailSectionBlock key={section.title} section={section} />
      ))}
    </Box>
  )
}

// =============================================================================
// SummaryLine
// =============================================================================

/** Props for {@link SummaryLine}. */
export interface SummaryLineProps {
  /** Parts joined by the dimmed `·` separator. */
  readonly parts: readonly string[]
}

/**
 * Dimmed summary line, `·`-joined (generalizes `TaskList`'s `Summary`).
 * The `·` honors ascii fallback via `useSymbols`. Renders nothing when empty.
 */
export const SummaryLine = ({ parts }: SummaryLineProps): ReactNode => {
  const symbols = useSymbols()
  if (parts.length === 0) return null

  return <Text dim>{parts.join(` ${symbols.status.dot} `)}</Text>
}

// =============================================================================
// StatusGlyph
// =============================================================================

/** Props for {@link StatusGlyph}. */
export interface StatusGlyphProps {
  /** Status to map to a glyph. */
  readonly kind: StatusSymbol
}

/**
 * Maps a {@link StatusSymbol} to its glyph: `modified` → `*`, `diverged` → `↕`,
 * `ok` → `✓`, `error` → `✗`.
 *
 * `ok`/`error` resolve through `useSymbols` (so they ascii-fall back to `+`/`x`
 * under `NO_UNICODE`). `modified` is `*` in both variants; `diverged` has no
 * tui-core symbol def, so its ascii fallback (`^v`) is gated on the same
 * `unicode` render-config flag that drives `useSymbols`.
 */
export const StatusGlyph = ({ kind }: StatusGlyphProps): ReactNode => {
  const symbols = useSymbols()
  const { unicode } = useRenderConfig()

  switch (kind) {
    case 'modified':
      return <Text>*</Text>
    case 'diverged':
      return <Text>{unicode === true ? '↕' : '^v'}</Text>
    case 'ok':
      return <Text>{symbols.status.check}</Text>
    case 'error':
      return <Text>{symbols.status.cross}</Text>
  }
}

// =============================================================================
// StageList
// =============================================================================

/** Props for {@link StageList}. */
export interface StageListProps {
  /** Write-progress stages, reusing `TaskList`'s item shape. */
  readonly items: readonly TaskItem[]
  /** Whether to show the `·`-joined summary line (default: false). */
  readonly showSummary?: boolean | undefined
  /** Optional title above the list. */
  readonly title?: string | undefined
  /** Optional elapsed time in ms shown in the summary. */
  readonly elapsed?: number | undefined
}

/**
 * Thin wrapper over {@link TaskList} for write-progress stages, so callers
 * import a single kit. Reuses `TaskItemSchema` (no parallel stage type).
 */
export const StageList = ({ items, showSummary, title, elapsed }: StageListProps): ReactNode => (
  <TaskList
    items={items}
    {...(showSummary !== undefined ? { showSummary } : {})}
    {...(title !== undefined ? { title } : {})}
    {...(elapsed !== undefined ? { elapsed } : {})}
  />
)

// =============================================================================
// CommandOutput
// =============================================================================

/** Props for {@link CommandOutput}. */
export interface CommandOutputProps {
  /** Optional context header line (e.g. `notion-md status · file.nmd`). */
  readonly context?: string | undefined
  /** Problems, split into CRITICAL then WARNING groups. */
  readonly problems: readonly ProblemItem[]
  /** Detail sections shown as main content. */
  readonly sections: readonly DetailSection[]
  /** Optional write-progress stages shown as main content. */
  readonly stages?: readonly TaskItem[] | undefined
  /** Optional summary-line parts (`·`-joined, dimmed). */
  readonly summary?: readonly string[] | undefined
}

/**
 * Conventional assembly enforcing the `/sk-cli-design` structure:
 *
 * ```
 * <context-header>
 * <CRITICAL items>
 * <WARNING items>
 * <separator>        (only when any problems exist)
 * <stages / sections>
 * <summary-line>
 * ```
 *
 * Conditional display: empty problem groups and the separator are omitted,
 * empty sections/stages are omitted, and there are no trailing blank lines.
 */
export const CommandOutput = ({
  context,
  problems,
  sections,
  stages,
  summary,
}: CommandOutputProps): ReactNode => {
  const symbols = useSymbols()

  const critical = problems.filter((problem) => problem.severity === 'critical')
  const warning = problems.filter((problem) => problem.severity === 'warning')
  const hasProblems = problems.length > 0

  const hasStages = stages !== undefined && stages.length > 0
  const visibleSections = sections.filter((section) => isSectionVisible(section) === true)
  const hasMainContent = hasStages === true || visibleSections.length > 0
  const hasSummary = summary !== undefined && summary.length > 0

  /** Blocks rendered top-to-bottom, with 1 blank line between present blocks. */
  const blocks: ReactNode[] = []

  if (context !== undefined) blocks.push(<Text key="context">{context}</Text>)

  // `/sk-cli-design` spacing: 1 blank line after a section badge (the blank
  // `<Text>` sibling between badge and list — direct siblings stack reliably).
  if (critical.length > 0) {
    blocks.push(
      <Box key="critical">
        <SeverityBadge severity="critical" />
        <Text>{''}</Text>
        <ProblemList items={critical} />
      </Box>,
    )
  }

  if (warning.length > 0) {
    blocks.push(
      <Box key="warning">
        <SeverityBadge severity="warning" />
        <Text>{''}</Text>
        <ProblemList items={warning} />
      </Box>,
    )
  }

  // Separator only when problems exist AND there is main content to separate.
  if (hasProblems === true && hasMainContent === true) {
    blocks.push(
      <Text key="separator" dim>
        {symbols.line.horizontal.repeat(3)}
      </Text>,
    )
  }

  if (hasStages === true) blocks.push(<StageList key="stages" items={stages} />)
  if (visibleSections.length > 0) {
    blocks.push(<DetailSections key="sections" sections={visibleSections} />)
  }
  if (hasSummary === true) blocks.push(<SummaryLine key="summary" parts={summary} />)

  return stackWithBlankLines(blocks)
}

// =============================================================================
// Internal helpers
// =============================================================================

/** Max detail items shown before truncating to `+ N more`. */
const MAX_SECTION_ITEMS = 5

/** A section is shown when it has items or a positive `more` count. */
const isSectionVisible = (section: DetailSection): boolean =>
  section.items.length > 0 || (section.more ?? 0) > 0

/**
 * Stack `blocks` in a single column with exactly one blank line between each.
 *
 * Uses empty `<Text>` separators rather than `paddingTop` wrappers: wrapping a
 * multi-line column in a padded `Box` collapses its measured height to one line
 * in the layout engine, whereas blank-text siblings stack reliably.
 */
const stackWithBlankLines = (blocks: readonly ReactNode[]): ReactNode => (
  <Box>
    {blocks.map((block, index) => (
      <Box key={blockKey({ block, index })}>
        {index > 0 && <Text>{''}</Text>}
        {block}
      </Box>
    ))}
  </Box>
)

/** Stable key for a stacked block: its own element key, falling back to position. */
const blockKey = ({ block, index }: { block: ReactNode; index: number }): string =>
  isValidElement(block) === true && block.key !== null ? block.key : `block-${index}`

/** One problem item: header line, optional context, then fix/skip lines. */
const ProblemEntry = ({ item }: { readonly item: ProblemItem }): ReactNode => (
  <Box>
    <Box flexDirection="row">
      <Text bold>{`  ${item.name}`}</Text>
      <Text dim>{` ${item.status} ${item.details}`}</Text>
    </Box>
    {item.context !== undefined && <Text dim>{`    ${item.context}`}</Text>}
    {item.fixes.map((fix) => (
      <Text key={`fix:${fix}`} color="cyan">{`    fix: ${fix}`}</Text>
    ))}
    {(item.skips ?? []).map((skip) => (
      <Text key={`skip:${skip}`} dim>{`    skip: ${skip}`}</Text>
    ))}
  </Box>
)

/** One detail section: `title(count):` header, capped items, optional `+ N more`. */
const DetailSectionBlock = ({ section }: { readonly section: DetailSection }): ReactNode => {
  const more = section.more ?? 0
  const count = section.items.length + more
  const shown = section.items.slice(0, MAX_SECTION_ITEMS)

  return (
    <Box>
      <Text>{`  ${section.title}(${count}):`}</Text>
      {shown.map((detail, index) => (
        <Text key={`${index}:${detail}`} dim>{`    ${detail}`}</Text>
      ))}
      {more > 0 && <Text dim>{`    + ${more} more`}</Text>}
    </Box>
  )
}
