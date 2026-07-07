#!/usr/bin/env bun
/**
 * Post-build emit: copy the single-file Vite artifact to the served location.
 *   dist/index.html  ->  demo/explainers/control.next.html
 *
 * We build to a local dist/ (avoids Vite's outside-root outDir friction) then
 * copy. The artifact must be fully self-contained (vite-plugin-singlefile), so
 * a single file is all there is to move.
 */
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)) // app/scripts
const APP = join(HERE, '..')
const DIST = join(APP, 'dist')
const SRC = join(DIST, 'index.html')
const OUT = join(APP, '..', '..', 'explainers', 'control.next.html') // demo/explainers/control.next.html

if (!existsSync(SRC)) {
  console.error(`emit: ${SRC} not found — did vite build run?`)
  process.exit(1)
}

// Guard the zero-external-request invariant: dist should carry no stray chunks.
const stray = readdirSync(DIST).filter((f) => /\.(js|css)$/.test(f) || f === 'assets')
if (stray.length > 0) {
  console.error(`emit: dist contains non-inlined assets (singlefile invariant broken): ${stray.join(', ')}`)
  process.exit(1)
}

copyFileSync(SRC, OUT)
console.log(`emit: wrote ${OUT}`)
