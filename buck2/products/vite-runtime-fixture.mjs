import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { build } from 'vite'

const libexec = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
if (require('@fixture/native-slot') !== 'native-slot-ok')
  throw new Error('native slot did not resolve beside the runtime closure')
const ptyPackage = await realpath(join(libexec, 'importers', 'pty', 'node_modules', '@myobie', 'pty'))
const requirePtyDependency = createRequire(join(ptyPackage, 'package.json'))
const addonPath = await realpath(requirePtyDependency.resolve('node-pty'))
if (!addonPath.startsWith(join(libexec, '.pnpm') + sep))
  throw new Error('native addon escaped the pinned runtime closure')
if (typeof requirePtyDependency('node-pty').spawn !== 'function')
  throw new Error('native addon did not load from the normalized store entry')
const root = await mkdtemp(join(tmpdir(), 'vite-runtime-closure-'))
try {
  // Vite resolves the project's source imports from `root`, not from this
  // executable's own module URL. A temporary project needs its own first hop.
  await symlink(
    join(dirname(fileURLToPath(import.meta.url)), 'node_modules'),
    join(root, 'node_modules'),
  )
  await writeFile(
    join(root, 'index.html'),
    '<div id="app"></div><script type="module" src="/main.jsx"></script>\n',
  )
  await writeFile(
    join(root, 'main.jsx'),
    "import React from 'react'; import { createRoot } from 'react-dom/client'; createRoot(document.getElementById('app')).render(<strong>runtime-closure-ok</strong>);\n",
  )
  await build({
    root,
    configFile: false,
    plugins: [react()],
    build: { outDir: join(root, 'dist'), emptyOutDir: true, minify: false },
  })
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8')
  if (!html.includes('/assets/')) throw new Error('Vite did not emit a JavaScript asset')
  process.stdout.write('vite-runtime-closure: build passed\n')
} finally {
  await rm(root, { recursive: true, force: true })
}
