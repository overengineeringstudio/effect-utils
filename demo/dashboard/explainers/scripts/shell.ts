/**
 * shell.ts — the document template. Assembles a standalone, same-origin,
 * normal-flow HTML doc: a `<style>` blob (inlined kit CSS + per-explainer CSS),
 * the static markup renderToStaticMarkup produced, and one inline `<script>`
 * (the verbatim engine). Byte-shaped like the hand-authored explainers.
 *
 * INVARIANT: no `min-h-screen`/100vh root — the doc is normal-flow so the
 * dashboard's ExplainerFrame can measure `documentElement.scrollHeight`
 * (guarded in guard.ts).
 */
export interface ShellOpts {
  readonly title: string
  readonly css: string
  readonly body: string
  readonly script: string
}

export function documentShell({ title, css, body, script }: ShellOpts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
${css}
</style>
</head>
<body>
${body}
<script>
${script}
</script>
</body>
</html>
`
}
