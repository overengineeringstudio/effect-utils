import { Fragment, type ReactNode } from 'react'

/**
 * Render one raw prose line as inline markdown in JSX (escaping is automatic —
 * React text nodes are escaped). Mirrors screenplay.ts `inlineMd` semantics as
 * used by build.ts: a leading "- " bullet, then **bold**, then `code`.
 *
 * build.ts applies the two replacements SEQUENTIALLY — bold first across the
 * whole string, then code — so `code` nested inside **bold** renders as
 * `<strong>…<code>…</code>…</strong>`. The previous single combined-alternation
 * regex could not nest and emitted the literal ` ``/`**` delimiters for
 * `**bold with `code` inside**`. We reproduce the sequential/nesting behavior:
 * split on bold first, then tokenize `code` inside BOTH bold spans and the
 * surrounding plain text.
 */

// Split a run of text on `code` spans → array of ReactNodes (plain text + <code>).
const renderCode = (text: string, keyBase: string): ReactNode[] => {
  const nodes: ReactNode[] = []
  const re = /`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={`${keyBase}-${key++}`}>{text.slice(last, m.index)}</Fragment>)
    nodes.push(
      <code key={`${keyBase}-${key++}`} className="rounded bg-bg-subtle px-1 text-fg">
        {m[1]}
      </code>,
    )
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(<Fragment key={`${keyBase}-${key++}`}>{text.slice(last)}</Fragment>)
  return nodes
}

export const InlineMd = ({ line }: { line: string }): ReactNode => {
  let s = line
  let bulleted = false
  if (/^\s*-\s+/.test(s)) {
    bulleted = true
    s = s.replace(/^\s*-\s+/, '')
  }

  // Bold FIRST (matching build.ts `.replace(/\*\*([^*]+)\*\*/g,…)`), then code
  // inside each resulting span.
  const nodes: ReactNode[] = []
  const re = /\*\*([^*]+)\*\*/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) nodes.push(...renderCode(s.slice(last, m.index), `t${key++}`))
    nodes.push(<strong key={`b${key++}`}>{renderCode(m[1]!, `bc${key}`)}</strong>)
    last = re.lastIndex
  }
  if (last < s.length) nodes.push(...renderCode(s.slice(last), `t${key++}`))

  return (
    <>
      {bulleted && <span className="mr-1 text-fg-faint">•</span>}
      {nodes}
    </>
  )
}
