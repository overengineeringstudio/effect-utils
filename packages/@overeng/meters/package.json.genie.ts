// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import otelBrowserPkg from '../otel-browser/package.json.genie.ts'
import utilsStorybookPkg from '../utils-storybook/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['react', 'react-dom', 'effect'] as const
const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/meters' }),
  devDependencies: {
    workspace: [utilsPkg, utilsStorybookPkg, otelBrowserPkg],
    external: catalog.pick(
      ...peerDepNames,
      '@types/node',
      '@types/react',
      '@types/react-dom',
      '@storybook/react',
      '@storybook/react-vite',
      '@storybook/addon-a11y',
      '@testing-library/react',
      'happy-dom',
      '@vitest/browser',
      '@vitest/browser-playwright',
      '@playwright/test',
      'playwright',
      '@vitejs/plugin-react',
      'storybook',
      'typescript',
      'vite',
      'vitest',
      '@effect/vitest',
    ),
  },
  peerDependencies: { external: catalog.pick(...peerDepNames) },
})

type Environment = 'browser' | 'isomorphic-es2024'

/** Public subpaths with their `src/` module and genie export environment. */
const entries: ReadonlyArray<{ subpath: string; src: string; environment: Environment }> = [
  { subpath: '.', src: 'index.ts', environment: 'isomorphic-es2024' },
  { subpath: './series', src: 'series/index.ts', environment: 'isomorphic-es2024' },
  { subpath: './headless', src: 'headless/index.ts', environment: 'isomorphic-es2024' },
  { subpath: './platform/browser', src: 'platform/browser.ts', environment: 'browser' },
  { subpath: './sources/frame', src: 'sources/frame/index.ts', environment: 'browser' },
  { subpath: './sources/long-frames', src: 'sources/long-frames/index.ts', environment: 'browser' },
  { subpath: './sources/memory', src: 'sources/memory/index.ts', environment: 'browser' },
  { subpath: './sources/fibers', src: 'sources/fibers/index.ts', environment: 'isomorphic-es2024' },
  { subpath: './sources/spans', src: 'sources/spans/index.ts', environment: 'isomorphic-es2024' },
  {
    subpath: './sources/otel-browser',
    src: 'sources/otel-browser/index.ts',
    environment: 'browser',
  },
  {
    subpath: './sources/counters',
    src: 'sources/counters/index.ts',
    environment: 'isomorphic-es2024',
  },
  { subpath: './sources/status', src: 'sources/status/index.ts', environment: 'isomorphic-es2024' },
  { subpath: './canvas', src: 'canvas/index.ts', environment: 'browser' },
  { subpath: './canvas/layout', src: 'canvas/layout.ts', environment: 'isomorphic-es2024' },
  { subpath: './react', src: 'react/index.tsx', environment: 'browser' },
]

const dts = (src: string) => `./dist/${src.replace(/\.tsx?$/, '.d.ts')}`
const js = (src: string) => `./dist/${src.replace(/\.tsx?$/, '.js')}`

export default packageJson(
  {
    name: '@overeng/meters',
    version: '0.1.0',
    description:
      'Canvas performance meters and headless measurement windows for React applications',
    license: 'MIT',
    type: 'module',
    files: ['package.json', 'dist', 'src', '!dist/**/*.tsbuildinfo'],
    exports: Object.fromEntries(
      entries.map(({ subpath, src, environment }) => [
        subpath,
        exportEntry({ types: dts(src), default: `./src/${src}` }, { environment }),
      ]),
    ),
    publishConfig: {
      access: 'public',
      exports: Object.fromEntries(
        entries.map(({ subpath, src }) => [subpath, { types: dts(src), default: js(src) }]),
      ),
    },
    scripts: {
      build: 'tsc --build tsconfig.json && vite build',
      storybook: 'storybook dev -p 6019',
      'storybook:build': 'storybook build',
      gate: 'bun node_modules/@overeng/utils-storybook/src/gate/cli.ts',
      'test:e2e': 'playwright test',
    },
  } satisfies PackageJsonInputData,
  runtimeDeps,
)
