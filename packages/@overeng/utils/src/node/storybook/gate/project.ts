/**
 * Vitest config factory for the story-driven visual + accessibility gate.
 *
 * @module
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { storybookTest } from '@storybook/addon-vitest/vitest-plugin'
import { playwright } from '@vitest/browser-playwright'
import type { ViteUserConfig } from 'vitest/config'

/**
 * Directory the current run compares against, supplied by `runStoryGate`.
 *
 * The gate config is executed in a Vitest child process, so the derived
 * baseline location travels as an environment variable rather than an argument.
 */
export const baselineDirEnvVar = 'OVERENG_STORY_GATE_BASELINE_DIR'

/**
 * File the config appends every resolved baseline path to.
 *
 * `resolveScreenshotPath` is called exactly once per story assertion, which
 * makes it the cheapest faithful record of which baselines the current tree
 * actually asked for. A baseline present on disk but absent from this list is a
 * story that disappeared — the one gate failure the runner cannot infer from
 * test results, because a story that no longer exists produces no test.
 */
export const manifestEnvVar = 'OVERENG_STORY_GATE_MANIFEST'

/** A theme the gate covers, expressed as a Storybook toolbar global. */
export interface StoryGateTheme {
  /** Toolbar global name, e.g. `'theme'`. */
  readonly name: string
  /** Value to pin for this project, e.g. `'dark'`. */
  readonly value: string
}

/** Options for {@link createStoryGateConfig}. */
export interface StoryGateConfigOptions {
  /** Storybook config dir, relative to the Vitest config file. @default '.storybook' */
  readonly configDir?: string
  /**
   * One Vitest project per theme. Requires Storybook >= 10.5, which is where
   * `initialGlobals` became a per-project option.
   */
  readonly themes?: readonly StoryGateTheme[]
  /** @default true */
  readonly headless?: boolean
  /**
   * Vite plugins the stories need in order to load, e.g. a compiler transform.
   *
   * These MUST arrive here rather than being merged into the returned config,
   * because **Vitest projects do not inherit root-level `plugins`** — each
   * project is its own Vite config. Merging at the root works only by accident
   * in the single-theme case, where this factory returns a bare project config
   * and the caller's merge target *is* the project. Add a second theme and the
   * same merge silently stops applying: the return shape becomes
   * `{ test: { projects } }`, the plugins land beside `test` where nothing reads
   * them, and every story fails to load with a runtime error from the
   * untransformed source.
   *
   * That failure was reproduced end to end: one-theme consumer ran 4 stories,
   * two-theme consumer reported `Tests no tests`, and threading the same
   * plugins through this option moved it to 10 stories executed.
   */
  readonly plugins?: ViteUserConfig['plugins']
}

const readBaselineRoot = (): string => {
  const baselineRoot = process.env[baselineDirEnvVar]
  if (baselineRoot === undefined || baselineRoot === '') {
    throw new Error(
      `[story-gate] ${baselineDirEnvVar} is not set. Baselines are derived from a git ref by \`runStoryGate\`, never committed, so this config cannot be run directly.`,
    )
  }
  return baselineRoot
}

const recordResolvedBaseline = (path: string): void => {
  const manifest = process.env[manifestEnvVar]
  if (manifest === undefined || manifest === '') return
  appendFileSync(manifest, `${path}\n`)
}

/**
 * Build the Storybook test plugin for one project.
 *
 * Injected rather than called inline so the plugin-placement invariant is
 * unit-testable. `storybookTest` eagerly loads a real Storybook config
 * directory, so a test that invoked it would need a Storybook install and a
 * fixture `main.ts` in a package that has neither — and the thing worth
 * guarding is *where the plugins land*, which is independent of what they are.
 */
export type StorybookPluginFor = (args: {
  configDir: string
  theme: StoryGateTheme | undefined
}) => NonNullable<ViteUserConfig['plugins']>[number]

const defaultStorybookPluginFor: StorybookPluginFor = ({ configDir, theme }) =>
  storybookTest({
    configDir,
    ...(theme === undefined ? {} : { initialGlobals: { [theme.name]: theme.value } }),
  })

const createProject = ({
  configDir,
  theme,
  headless,
  baselineRoot,
  plugins,
  storybookPluginFor,
}: {
  configDir: string
  theme: StoryGateTheme | undefined
  headless: boolean
  baselineRoot: string
  plugins: ViteUserConfig['plugins']
  storybookPluginFor: StorybookPluginFor
}): ViteUserConfig => {
  const projectName = theme === undefined ? 'story-gate' : `story-gate-${theme.value}`
  const baselineDir = join(baselineRoot, projectName)

  return {
    // Caller plugins come first: a compiler transform has to see the source
    // before the Storybook plugin turns it into a test module.
    plugins: [...(plugins ?? []), storybookPluginFor({ configDir, theme })],
    // The baseline half of a run happens inside a git worktree that borrows the
    // main tree's `node_modules` by symlink, so workspace sources — this gate's
    // own setup file among them — resolve to paths outside the served root and
    // Vite refuses them. This is a throwaway test server; strict roots buy
    // nothing here and cost the derived-baseline mechanism entirely.
    server: { fs: { strict: false } },
    test: {
      name: projectName,
      setupFiles: ['@overeng/utils/node/storybook/gate/setup'],
      browser: {
        enabled: true,
        headless,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
        // Capturing several stories concurrently in one browser context
        // corrupted frames nondeterministically — a few stories per run showed
        // a stale duplicate band from racing full-page captures. Sequential
        // capture was byte-stable across runs and the concurrency saving was
        // under a quarter of the runtime, so it buys nothing.
        fileParallelism: false,
        expect: {
          toMatchScreenshot: {
            comparatorName: 'pixelmatch',
            comparatorOptions: {
              // Both of these are non-default and both defaults fail silently.
              // `allowedMismatchedPixelRatio: 0` alone does NOT compare exactly:
              // pixelmatch defaults to a perceptual `threshold` of 0.1 and to
              // ignoring anti-aliased pixels. Measured — a token mis-map moving
              // a radius by one pixel and one colour channel by six passed
              // across three stories under those defaults.
              threshold: 0,
              includeAA: true,
              allowedMismatchedPixels: 0,
            },
            resolveScreenshotPath: ({ arg, ext, testFileDirectory, testFileName }) => {
              const path = join(baselineDir, testFileDirectory, testFileName, `${arg}${ext}`)
              recordResolvedBaseline(path)
              return path
            },
          },
        },
      },
    },
  }
}

/**
 * Build the Vitest configuration that gates a package's stories.
 *
 * Three settings are non-default because each ecosystem default fails silently,
 * and all three are measured:
 *
 * 1. Comparator `threshold: 0` with `includeAA: true` — see the inline note.
 * 2. `parameters.a11y.test: 'error'`, applied through `setupFiles`; the default
 *    `'todo'` downgrades every violation to a warning. See `./annotations.ts`.
 * 3. Baselines resolved into a ref-derived directory rather than a committed
 *    one. Captures depend on the host's installed fonts wherever a generic
 *    family is used: forcing a different family moved one to three thousand
 *    pixels per story, one to two orders of magnitude more than a real
 *    regression, so a committed baseline is only valid on the machine that
 *    produced it. Deriving both sides in one run on one host cancels the host
 *    out exactly.
 */
export const createStoryGateConfig = ({
  configDir = '.storybook',
  themes,
  headless = true,
  plugins,
  storybookPluginFor = defaultStorybookPluginFor,
}: StoryGateConfigOptions & {
  /** Seam for unit tests; production callers never pass this. */
  readonly storybookPluginFor?: StorybookPluginFor
} = {}): ViteUserConfig => {
  const baselineRoot = readBaselineRoot()
  const projects = (themes ?? [undefined]).map((theme) =>
    createProject({ configDir, theme, headless, baselineRoot, plugins, storybookPluginFor }),
  )

  return projects.length === 1 && projects[0] !== undefined ? projects[0] : { test: { projects } }
}
