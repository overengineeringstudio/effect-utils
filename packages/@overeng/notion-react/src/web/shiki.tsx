import { Children, useEffect, useState, type ReactNode } from 'react'

/**
 * Shiki renderer — dynamic-imports `shiki` so the ~1.1mb engine + grammars
 * only load when the first code block mounts. Peer dep is marked optional
 * in package.json; consumers opt in by installing `shiki`.
 *
 * SSR + unresolved-import fallback: render `<pre><code>` with the raw
 * source, matching the pre-shiki baseline. Once the import resolves and
 * `codeToHtml` returns, React swaps in the themed HTML.
 *
 * Only strings go through shiki — if `children` contains nested React
 * elements (rare for code blocks, but possible when the host projects
 * rich_text annotations), we keep the fallback output to avoid losing
 * structure.
 */

const asPlainText = (children: ReactNode): string | undefined => {
  const parts: string[] = []
  let ok = true
  Children.forEach(children, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child))
    } else if (child === null || child === undefined || typeof child === 'boolean') {
      /* skip */
    } else {
      ok = false
    }
  })
  return ok ? parts.join('') : undefined
}

export const ShikiRender = ({
  children,
  language,
}: {
  readonly children: ReactNode
  readonly language: string | undefined
}) => {
  const code = asPlainText(children)
  const [html, setHtml] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (code === undefined) return
    let cancelled = false
    import('shiki')
      .then(async (mod) => {
        const out = await mod.codeToHtml(code, {
          lang: language ?? 'text',
          theme: 'github-light',
        })
        if (!cancelled) setHtml(out)
      })
      .catch(() => {
        /* peer or grammar not available → keep plain fallback */
      })
    return () => {
      cancelled = true
    }
  }, [code, language])

  if (code === undefined || html === undefined) {
    return (
      <pre className="notion-code" data-language={language ?? 'plain text'}>
        <code>{children}</code>
      </pre>
    )
  }

  return (
    <div
      className="notion-code"
      data-language={language ?? 'plain text'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
