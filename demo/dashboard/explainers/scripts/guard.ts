/**
 * guard.ts — static single-file + iframe-safety assertions (mirrors the
 * dashboard's emit.ts stray-asset guard). Returns a list of problems; an empty
 * list means the output is a valid standalone same-origin doc. render.ts fails
 * the build (exit non-zero) if any problem is found.
 */
export function guardSingleFile(html: string): string[] {
  const problems: string[] = []

  // Zero external requests: no external stylesheets, scripts, fonts, images.
  if (/<link\b/i.test(html)) problems.push('<link> element present (external stylesheet/font)')
  if (/<script\b[^>]*\bsrc=/i.test(html)) problems.push('<script src=…> present (external script)')
  if (/url\(\s*['"]?https?:\/\//i.test(html)) problems.push('external url(http…) in CSS')
  if (/<img\b[^>]*\bsrc=\s*['"]https?:\/\//i.test(html)) problems.push('external <img src=http…>')
  if (/\b(?:href|src)\s*=\s*['"]\/\//i.test(html)) problems.push('protocol-relative //… reference')

  // In-iframe scrollHeight trap (App.tsx:324–335): a viewport-sized root makes
  // the iframe measure the viewport, not the content. The doc must be normal-flow.
  if (/min-h-screen/.test(html)) problems.push('min-h-screen root (breaks iframe scrollHeight)')
  if (/\b(?:height|min-height)\s*:\s*100vh/i.test(html)) problems.push('100vh root (breaks iframe scrollHeight)')

  return problems
}
