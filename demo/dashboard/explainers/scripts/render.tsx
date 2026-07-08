#!/usr/bin/env bun
/**
 * render.tsx — the SSG entry. For each registered explainer:
 *   1. renderToStaticMarkup(<Component/>)  → plain HTML (no React runtime, no
 *      hydration markers)
 *   2. inline the shared kit CSS (kit-page.css + kit-components.css) + the
 *      per-explainer content CSS + the verbatim engine.js
 *   3. guard the single-file / zero-request / iframe-safe invariants
 *   4. write demo/explainers/notion-<id>.next.html
 *
 * NO bundler, NO vite-plugin-singlefile, ZERO client React runtime. The "bundle"
 * is string concatenation. bun transpiles the .tsx + runs react-dom/server.
 *
 * Importing registry.tsx transitively constructs every explainer's syncStory,
 * so a causal inversion throws HERE — the build fails before any file is written.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync, writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { documentShell } from './shell.ts'
import { guardSingleFile } from './guard.ts'
import { EXPLAINERS } from '../src/registry.tsx'

const HERE = dirname(fileURLToPath(import.meta.url)) // demo/dashboard/explainers/scripts
const KIT = join(HERE, '..', '..', 'kit')
const SRC = join(HERE, '..', 'src')
const OUT_DIR = join(HERE, '..', '..', '..', 'explainers') // demo/explainers

const kitCss = [
  readFileSync(join(KIT, 'kit-page.css'), 'utf8'),
  readFileSync(join(KIT, 'kit-components.css'), 'utf8'),
].join('\n\n')
const engine = readFileSync(join(KIT, 'engine.js'), 'utf8')

let failed = false

for (const ex of EXPLAINERS) {
  const localCss = ex.css ? readFileSync(join(SRC, ex.css), 'utf8') : ''
  const css = localCss ? `${kitCss}\n\n${localCss}` : kitCss
  const body = renderToStaticMarkup(createElement(ex.Component))
  const html = documentShell({ title: ex.title, css, body, script: engine })

  const problems = guardSingleFile(html)
  if (problems.length > 0) {
    console.error(`✗ ${ex.id}: guard failed:`)
    for (const p of problems) console.error(`    - ${p}`)
    failed = true
    continue
  }

  const out = join(OUT_DIR, `notion-${ex.id}.next.html`)
  writeFileSync(out, html)
  console.log(`✓ ${ex.id} → ${out} (${(html.length / 1024).toFixed(1)} KB)`)
}

if (failed) process.exit(1)
