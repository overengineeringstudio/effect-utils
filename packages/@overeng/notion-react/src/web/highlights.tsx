import { Children, useEffect, useState, type ReactNode } from 'react'

/**
 * Highlights renderer — dynamic-imports the engine and theme so they only
 * load when the first code block mounts. Peer dep is marked optional in
 * package.json; consumers opt in by installing `@pierre/highlights`.
 *
 * SSR + unresolved-import fallback: render `<pre><code>` with the raw
 * source. Once the import resolves and
 * `codeToHtml` returns, React swaps in the themed HTML.
 *
 * Only strings go through Highlights — if `children` contains nested React
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

export const HighlightsRender = ({
  children,
  language,
}: {
  readonly children: ReactNode
  readonly language: string | undefined
}) => {
  const code = asPlainText(children)
  const [highlighted, setHighlighted] = useState<
    { readonly code: string; readonly language: string | undefined; readonly html: string } | undefined
  >(undefined)
  const html =
    highlighted !== undefined && highlighted.code === code && highlighted.language === language
      ? highlighted.html
      : undefined

  useEffect(() => {
    if (code === undefined) return
    let cancelled = false
    Promise.all([import('@pierre/highlights'), import('@pierre/highlights/themes')])
      .then(([mod, { githubLight }]) => {
        const lang = language ?? 'text'
        if (!mod.isSupportedLanguage(lang)) return
        const out = new TextDecoder().decode(mod.codeToHtml(code, { lang, theme: githubLight }))
        if (!cancelled) setHighlighted({ code, language, html: out })
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
