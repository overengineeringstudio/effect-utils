/**
 * Read-only JSX -> Notion-enhanced-Markdown projection for review artifacts,
 * CLI previews, and exports.
 *
 * @experimental Experimental surface (#1097): spellings and the diagnostics
 * contract may change until a real consumer has proven the output. See
 * `renderToNotionMarkdown` for the fidelity contract.
 *
 * @module
 */

export {
  renderToNotionMarkdown,
  type MarkdownDiagnostic,
  type MarkdownDiagnosticKind,
  type NotionMarkdownResult,
} from './render-to-notion-markdown.ts'
