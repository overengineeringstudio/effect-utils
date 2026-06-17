/**
 * `/sk-cli-design` CLI-output kit — shared schemas + presentational components
 * for rendering readable, actionable, information-dense CLI output across every
 * CLI (notion-md, notion-cli, megarepo).
 *
 * @module
 */

export { Severity, ProblemItem, DetailSection, StatusSymbol } from './schema.ts'

export {
  SeverityBadge,
  type SeverityBadgeProps,
  ProblemList,
  type ProblemListProps,
  DetailSections,
  type DetailSectionsProps,
  SummaryLine,
  type SummaryLineProps,
  StatusGlyph,
  type StatusGlyphProps,
  StageList,
  type StageListProps,
  CommandOutput,
  type CommandOutputProps,
} from './CliOutput.tsx'
