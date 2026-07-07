import { Fragment, type ReactNode } from 'react'

/**
 * Render one raw prose line as inline markdown in JSX (escaping is automatic —
 * React text nodes are escaped). Mirrors screenplay.ts `inlineMd`: leading
 * "- " bullet, **bold**, `code`. This is the raw-text model refinement — the
 * React path never touches pre-escaped HTML strings.
 */
export const InlineMd = ({ line }: { line: string }): ReactNode => {
  let s = line
  let bulleted = false
  if (/^\s*-\s+/.test(s)) {
    bulleted = true
    s = s.replace(/^\s*-\s+/, '')
  }
  // Tokenize **bold** and `code`; everything else is plain (auto-escaped) text.
  const nodes: ReactNode[] = []
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) nodes.push(<Fragment key={key++}>{s.slice(last, m.index)}</Fragment>)
    if (m[1] !== undefined) {
      nodes.push(<strong key={key++}>{m[1]}</strong>)
    } else if (m[2] !== undefined) {
      nodes.push(
        <code key={key++} className="rounded bg-bg-subtle px-1 text-fg">
          {m[2]}
        </code>,
      )
    }
    last = re.lastIndex
  }
  if (last < s.length) nodes.push(<Fragment key={key++}>{s.slice(last)}</Fragment>)

  return (
    <>
      {bulleted && <span className="mr-1 text-fg-faint">•</span>}
      {nodes}
    </>
  )
}
