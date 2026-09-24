import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'
import { expect, it } from 'vitest'

import { createStylexVitePlugins } from './mod.js'

/**
 * End-to-end proof of the Next.js adapter: a minimal fixture app builds under
 * webpack, its extracted CSS carries the expected atomic rules, and — the
 * invariant the shared options object exists for — the class names are
 * identical to what the Vite/Babel path produces for the same token source.
 *
 * The fixture is materialized at run time and its `node_modules` is assembled
 * by symlinking from this package's installed graph, following the
 * installed-consumer pattern in `mod.installed-consumer.test.ts` (#1167).
 */
const packageRoot = fileURLToPath(new URL('../../..', import.meta.url))

/** Explicit bounds: Vitest cannot interrupt a synchronous child on its own. */
const INSTALL_TIMEOUT_MS = 90_000
const BUILD_TIMEOUT_MS = 180_000

/** Run a fixture child with a deadline and a diagnostic that names the phase. */
const runFixtureCommand = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; label: string; env?: NodeJS.ProcessEnv },
) => {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: options.env ?? process.env,
  })
  if (result.error !== undefined) {
    throw new Error(
      `${options.label} ${result.error.code === 'ETIMEDOUT' ? 'timed out' : 'failed'}: ${result.error.message}\n${result.stderr ?? ''}`,
      { cause: result.error },
    )
  }
  return result
}

/** The Vite fixture runs in-process, so plain symlinks suffice there. */
const viteFixtureDependencies = ['react', 'react-dom', '@stylexjs/stylex']

const tokensSource = [
  "import * as stylex from '@stylexjs/stylex'",
  '',
  'export const tokens = stylex.defineVars({',
  "  accent: '#b19cff',",
  "  ink: '#e8e9f3',",
  "  surface: '#151621',",
  "  radius: '6px',",
  '})',
  '',
].join('\n')

const cardSource = [
  "import * as stylex from '@stylexjs/stylex'",
  '',
  "import { tokens } from './tokens.stylex'",
  '',
  'export const card = stylex.create({',
  '  root: {',
  '    backgroundColor: tokens.surface,',
  '    borderRadius: tokens.radius,',
  '    color: tokens.ink,',
  "    padding: '16px',",
  '  },',
  '  title: {',
  '    color: tokens.accent,',
  "    fontFamily: 'system-ui, sans-serif',",
  "    fontSize: '18px',",
  '    fontWeight: 600,',
  '    margin: 0,',
  '  },',
  '})',
  '',
  'export function Card({ title }: { title: string }) {',
  '  return (',
  '    <section {...stylex.props(card.root)}>',
  '      <h2 {...stylex.props(card.title)}>{title}</h2>',
  '    </section>',
  '  )',
  '}',
  '',
].join('\n')

/**
 * The shared adapter instance, created once in a module both config files
 * import — the documented consumer shape this test must exercise, because the
 * one-options-object guarantee is what keeps the two passes from drifting.
 */
const sharedAdapterModule = [
  "import { fileURLToPath } from 'node:url'",
  '',
  "import { createStylexNext } from '@overeng/utils/node/stylex/next'",
  '',
  '// One instance shared by next.config and postcss.config: the Babel options',
  '// feeding the two passes are one object, not two copies.',
  'export const stylex = createStylexNext({',
  "  rootDir: fileURLToPath(new URL('.', import.meta.url)),",
  "  sourceDirs: ['src'],",
  "  cssCarrier: 'src/styles/globals.css',",
  '})',
  '',
].join('\n')

const nextConfigSource = [
  "import { stylex } from './stylex.mjs'",
  '',
  "/** @type {import('next').NextConfig} */",
  'const config = { transpilePackages: stylex.transpilePackages, webpack: stylex.webpack }',
  '',
  'export default config',
  '',
].join('\n')

const postcssConfigSource = [
  "import { stylex } from './stylex.mjs'",
  '',
  'const config = { plugins: { ...stylex.postcssPlugin } }',
  '',
  'export default config',
  '',
].join('\n')

const layoutSource = [
  "import type { ReactNode } from 'react'",
  '',
  "import '../styles/globals.css'",
  '',
  'export default function RootLayout({ children }: { children: ReactNode }) {',
  '  return (',
  '    <html lang="en">',
  '      <body>{children}</body>',
  '    </html>',
  '  )',
  '}',
  '',
].join('\n')

const pageSource = [
  "import { Card } from '../card'",
  '',
  'export default function Page() {',
  '  return <Card title="StyleX on Next" />',
  '}',
  '',
].join('\n')

const viteEntrySource = [
  "import { createRoot } from 'react-dom/client'",
  '',
  "import { Card } from './card'",
  '',
  "const container = document.getElementById('root')",
  "if (container === null) throw new Error('missing #root')",
  'createRoot(container).render(<Card title="StyleX on Vite" />)',
  '',
].join('\n')

const viteIndexHtml = [
  '<!doctype html>',
  '<html lang="en">',
  '  <body>',
  '    <div id="root"></div>',
  '    <script type="module" src="/src/entry.tsx"></script>',
  '  </body>',
  '</html>',
  '',
].join('\n')

/**
 * Where the fixture's dependencies symlink from. Overridable so an
 * alternative Next major (15.5 vs 16) can be proven without changing the
 * pinned devDependencies — the adapter supports both and the fixture
 * auto-detects which `--webpack` flag the installed major needs.
 */
const fixtureDependencyRoot =
  process.env.STYLEX_NEXT_FIXTURE_DEPS ?? join(packageRoot, 'node_modules')

/** The installed version of a dependency, read from the graph under test. */
const installedVersion = (name: string) =>
  (
    JSON.parse(readFileSync(join(fixtureDependencyRoot, name, 'package.json'), 'utf8')) as {
      version: string
    }
  ).version

/**
 * Places this package where a fixture's configs can import it. The adapter
 * entry is checked JavaScript with no dependencies, so a copy of the manifest
 * and the entry directory is a faithful stand-in for an installed package
 * (#1167).
 */
const linkAdapterPackage = (consumerRoot: string) => {
  const installedPackage = join(consumerRoot, 'node_modules', '@overeng', 'utils')
  mkdirSync(installedPackage, { recursive: true })
  cpSync(join(packageRoot, 'package.json'), join(installedPackage, 'package.json'))
  cpSync(
    join(packageRoot, 'src', 'node', 'stylex'),
    join(installedPackage, 'src', 'node', 'stylex'),
    {
      recursive: true,
    },
  )
}

/**
 * Installs the Next fixture's dependencies from the registry. A real install,
 * not symlinks: Next 16's build spawns static-generation workers and traces
 * outputs through node_modules, and a symlinked topology whose targets live
 * outside the app root makes the first (cold) build exit 1 with no
 * diagnostics — reproduced with no StyleX and no webpack hook at all. The
 * versions come from this package's installed graph, so the pins under test
 * stay owned by the genie catalog.
 */
const installFixtureDependencies = (fixtureRoot: string) => {
  writeFileSync(
    join(fixtureRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture-next',
        private: true,
        packageManager: 'pnpm@12.4.1',
        dependencies: {
          next: installedVersion('next'),
          react: installedVersion('react'),
          'react-dom': installedVersion('react-dom'),
          '@stylexjs/stylex': installedVersion('@stylexjs/stylex'),
          postcss: installedVersion('postcss'),
        },
        devDependencies: {
          // Next's dependency check requires the classic typescript package
          // layout (`lib/typescript.js`), which the catalog's native TS 7
          // package no longer ships — the fixture type-checks for real with
          // the classic compiler.
          typescript: '5.9.3',
          '@types/react': installedVersion('@types/react'),
          '@types/node': installedVersion('@types/node'),
          'babel-loader': installedVersion('babel-loader'),
          '@stylexjs/babel-plugin': installedVersion('@stylexjs/babel-plugin'),
          '@stylexjs/postcss-plugin': installedVersion('@stylexjs/postcss-plugin'),
        },
      },
      null,
      2,
    )}\n`,
  )
  // sharp (next's optional image dependency) ships an install script; pnpm
  // refuses undecided build scripts, and the fixture needs none of them.
  writeFileSync(join(fixtureRoot, 'pnpm-workspace.yaml'), 'allowBuilds:\n  sharp: false\n')
  const install = runFixtureCommand('corepack', ['pnpm', 'install'], {
    cwd: fixtureRoot,
    timeout: INSTALL_TIMEOUT_MS,
    label: 'fixture pnpm install',
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  })
  expect({ status: install.status, stderr: install.stderr }, 'fixture pnpm install failed').toEqual(
    { status: 0, stderr: '' },
  )
}

/** Links an installed dependency graph into a throwaway consumer. */
const linkFixtureDependencies = (consumerRoot: string, names: readonly string[]) => {
  for (const name of names) {
    const target = join(consumerRoot, 'node_modules', name)
    mkdirSync(join(target, '..'), { recursive: true })
    symlinkSync(join(fixtureDependencyRoot, name), target, 'dir')
  }
  linkAdapterPackage(consumerRoot)
}

/** StyleX atomic class names mentioned by a stylesheet, de-duplicated. */
const classNamesIn = (css: string) => [...new Set(css.match(/\.x[a-z0-9]+/gu) ?? [])].sort()

it('terminates and identifies a hung fixture child instead of waiting for Vitest', () => {
  // Real process deadlines cannot be driven by fake timers; this exercises
  // Node's spawnSync timeout against a child that will never finish itself.
  expect(() =>
    runFixtureCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmpdir(),
      timeout: 100,
      label: 'hung fixture',
    }),
  ).toThrowError(/hung fixture timed out/u)
})

it(
  'builds a fixture Next app whose StyleX CSS matches the Vite path',
  { timeout: 300_000 },
  async () => {
    const nextRoot = mkdtempSync(join(tmpdir(), 'overeng-stylex-next-build-'))
    const viteRoot = mkdtempSync(join(tmpdir(), 'overeng-stylex-next-vite-'))
    try {
      // --- the Next fixture -------------------------------------------------
      installFixtureDependencies(nextRoot)
      mkdirSync(join(nextRoot, 'src', 'app'), { recursive: true })
      mkdirSync(join(nextRoot, 'src', 'styles'), { recursive: true })
      writeFileSync(join(nextRoot, 'stylex.mjs'), sharedAdapterModule)
      writeFileSync(join(nextRoot, 'next.config.mjs'), nextConfigSource)
      writeFileSync(join(nextRoot, 'postcss.config.mjs'), postcssConfigSource)
      writeFileSync(join(nextRoot, 'src', 'styles', 'globals.css'), '@stylex;\n')
      writeFileSync(join(nextRoot, 'src', 'tokens.stylex.ts'), tokensSource)
      writeFileSync(join(nextRoot, 'src', 'card.tsx'), cardSource)
      writeFileSync(join(nextRoot, 'src', 'app', 'layout.tsx'), layoutSource)
      writeFileSync(join(nextRoot, 'src', 'app', 'page.tsx'), pageSource)
      linkAdapterPackage(nextRoot)

      const nextPackage = JSON.parse(
        readFileSync(realpathSync(join(nextRoot, 'node_modules', 'next', 'package.json')), 'utf8'),
      ) as { version: string }
      const nextMajor = Number(nextPackage.version.split('.')[0])
      // Next 16 defaults `build` to Turbopack; the adapter is webpack-mode.
      const buildArgs = ['build', ...(nextMajor >= 16 ? ['--webpack'] : [])]
      const buildResult = runFixtureCommand(
        process.execPath,
        [join('node_modules', 'next', 'dist', 'bin', 'next'), ...buildArgs],
        {
          cwd: nextRoot,
          timeout: BUILD_TIMEOUT_MS,
          label: `next ${buildArgs.join(' ')}`,
          env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        },
      )
      expect(
        {
          status: buildResult.status,
          stdout: buildResult.stdout,
          stderr: buildResult.stderr,
        },
        `next ${buildArgs.join(' ')} failed`,
      ).toEqual({ status: 0, stdout: expect.any(String), stderr: expect.any(String) })

      const cssDir = join(nextRoot, '.next', 'static', 'css')
      const nextCss = readdirSync(cssDir)
        .filter((name) => name.endsWith('.css'))
        .map((name) => readFileSync(join(cssDir, name), 'utf8'))
        .join('')
      const compactNextCss = nextCss.replace(/\s+/g, '')

      // The carrier's contents — not just any CSS — carry the atomic rules.
      // Token-referencing declarations compile to var() indirection with the
      // values in the emitted :root theme-vars rule; literals inline as-is.
      expect({
        borderRadius: compactNextCss.includes('border-radius:var(--'),
        padding: compactNextCss.includes('padding:16px'),
        fontWeight: compactNextCss.includes('font-weight:600'),
        accentToken: compactNextCss.includes('#b19cff'),
        surfaceToken: compactNextCss.includes('#151621'),
        residue: compactNextCss.includes('@stylex'),
      }).toEqual({
        borderRadius: true,
        padding: true,
        fontWeight: true,
        accentToken: true,
        surfaceToken: true,
        residue: false,
      })

      // The server-rendered markup references the compiled class names, so
      // the webpack-side transform and the PostCSS collection agreed.
      const html = readFileSync(join(nextRoot, '.next', 'server', 'app', 'index.html'), 'utf8')
      const htmlClassNames = [
        ...new Set(
          (html.match(/class="([^"]*)"/gu) ?? []).flatMap((attr) => attr.slice(7, -1).split(' ')),
        ),
      ].filter((name) => name.startsWith('x'))
      expect(htmlClassNames.length).toBeGreaterThan(0)
      for (const name of htmlClassNames) {
        expect(nextCss.includes(`.${name}`)).toBe(true)
      }

      // --- the Vite/Babel reference path ------------------------------------
      // The package.json matters: StyleX anchors theme-var hashing on the
      // nearest package, so without it the Vite fixture's var names hash
      // from the throwaway path instead of matching the Next fixture's.
      writeFileSync(join(viteRoot, 'package.json'), '{"name":"fixture-next","private":true}\n')
      mkdirSync(join(viteRoot, 'src'), { recursive: true })
      writeFileSync(join(viteRoot, 'index.html'), viteIndexHtml)
      writeFileSync(join(viteRoot, 'src', 'entry.tsx'), viteEntrySource)
      writeFileSync(join(viteRoot, 'src', 'tokens.stylex.ts'), tokensSource)
      writeFileSync(join(viteRoot, 'src', 'card.tsx'), cardSource)
      linkFixtureDependencies(viteRoot, viteFixtureDependencies)

      await build({
        root: viteRoot,
        configFile: false,
        plugins: createStylexVitePlugins({ entries: [join(viteRoot, 'src', 'entry.tsx')] }),
        esbuild: { jsx: 'automatic' },
        logLevel: 'warn',
        build: { outDir: 'dist' },
      })
      const viteCss = readdirSync(join(viteRoot, 'dist', 'assets'))
        .filter((name) => name.endsWith('.css'))
        .map((name) => readFileSync(join(viteRoot, 'dist', 'assets', name), 'utf8'))
        .join('')

      // Same token source, same compiler, one shared options shape: the
      // atomic class names must be identical across the two bundler paths.
      const viteNames = classNamesIn(viteCss)
      const nextNames = classNamesIn(nextCss)
      expect(viteNames).toEqual(nextNames)
      expect(viteNames.length).toBeGreaterThan(0)
    } finally {
      rmSync(nextRoot, { recursive: true, force: true })
      rmSync(viteRoot, { recursive: true, force: true })
    }
  },
)
