import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const root = await mkdtemp(join(tmpdir(), 'vite-runtime-closure-'))
try {
  await writeFile(join(root, 'index.html'), '<div id="app"></div><script type="module" src="/main.jsx"></script>\n')
  await writeFile(join(root, 'main.jsx'), "import React from 'react'; import { createRoot } from 'react-dom/client'; createRoot(document.getElementById('app')).render(<strong>runtime-closure-ok</strong>);\n")
  await build({ root, configFile: false, plugins: [react()], build: { outDir: join(root, 'dist'), emptyOutDir: true, minify: false } })
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8')
  if (!html.includes('/assets/')) throw new Error('Vite did not emit a JavaScript asset')
  process.stdout.write('vite-runtime-closure: build passed\n')
} finally {
  await rm(root, { recursive: true, force: true })
}
