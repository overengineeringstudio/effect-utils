import { useEffect, useState } from 'react'

/**
 * KaTeX renderer — dynamic-imports `katex` so the ~280kb engine is only
 * pulled in when the first equation actually mounts. Peer dep is marked
 * optional in package.json; consumers opt in by installing `katex` and
 * importing `@overeng/notion-react/web/katex.css`.
 *
 * SSR + unresolved-import fallback: render the raw expression as
 * `<code>`/`<pre><code>`, matching the pre-KaTeX baseline. Once the import
 * resolves (client-only), React swaps in the typeset HTML.
 */
export const KatexRender = ({
  expression,
  displayMode,
}: {
  readonly expression: string
  readonly displayMode: boolean
}) => {
  const [html, setHtml] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    import('katex')
      .then((mod) => {
        if (cancelled) return
        setHtml(
          mod.default.renderToString(expression, {
            displayMode,
            throwOnError: false,
            output: 'html',
          }),
        )
      })
      .catch(() => {
        /* peer not installed → keep plain fallback */
      })
    return () => {
      cancelled = true
    }
  }, [expression, displayMode])

  if (html === undefined) {
    return displayMode ? (
      <pre className="notion-equation-block">
        <code>{expression}</code>
      </pre>
    ) : (
      <code className="notion-equation">{expression}</code>
    )
  }

  return displayMode ? (
    <div className="notion-equation-block" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <span className="notion-equation" dangerouslySetInnerHTML={{ __html: html }} />
  )
}
