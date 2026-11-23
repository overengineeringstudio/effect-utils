import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import type { PlatformError } from 'effect/PlatformError'

import {
  ChangelogCompileError,
  compileChangelog,
  decodeScreenshotRecord,
  identityFromFilename,
  type EntryRegistration,
  type ScreenshotRecord,
} from '../compiler.ts'
import type { EntrySource, Manifest, PublishedImage } from '../contract.ts'
import { globToRegExp } from '../enforcement.ts'
import {
  DEFAULT_CHANGELOG_DIRECTORY,
  PUBLISHED_SCREENSHOT_PREFIX,
  RENDERER_VERSION,
  SCREENSHOTS_SUBDIRECTORY,
  type ChangelogConfig,
} from './config.ts'

/** One authored entry found on disk. */
export interface DiscoveredEntry<Text, Fields> {
  readonly id: string
  readonly file: string
  /** Absolute path of the entry module. */
  readonly path: string
  /** Absolute path of `<id>.scene.ts` (present iff the entry has a screenshot). */
  readonly scenePath: string
  readonly source: EntrySource<Text, Fields>
}

/** Absolute paths of a product's changelog directories. */
export const changelogPaths = Effect.fnUntraced(function* <Text, Fields>(
  config: ChangelogConfig<Text, Fields>,
) {
  const path = yield* Path.Path
  const directory = path.join(config.root, config.changelogDirectory ?? DEFAULT_CHANGELOG_DIRECTORY)
  return { directory, screenshots: path.join(directory, SCREENSHOTS_SUBDIRECTORY) }
})

const SCENE_SUFFIX = '.scene.ts'

/**
 * Loads every `YYYY-MM-DD-slug.ts` module (its `entry` export, strictly decoded). Any other
 * `.ts` file except `<id>.scene.ts` fails, so a misnamed entry can never be skipped silently.
 */
export const discoverEntries = Effect.fn('changelog.discoverEntries')(function* <Text, Fields>(
  config: ChangelogConfig<Text, Fields>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { directory } = yield* changelogPaths(config)
  const names = (yield* fs.readDirectory(directory)).toSorted()
  const entries: DiscoveredEntry<Text, Fields>[] = []
  for (const file of names) {
    if (file.endsWith('.ts') === false || file.endsWith(SCENE_SUFFIX) === true) continue
    const { id } = yield* Effect.try({
      try: () => identityFromFilename(file),
      catch: (error) => error as ChangelogCompileError,
    })
    const modulePath = path.join(directory, file)
    // The version query re-imports edited entries in long-lived processes (dev servers).
    const version = Option.match((yield* fs.stat(modulePath)).mtime, {
      onNone: () => 0,
      onSome: (date) => date.getTime(),
    })
    const module = yield* Effect.tryPromise({
      // Entry modules are discovered at runtime; each exports `entry` and type-only imports.
      try: (): Promise<{ readonly entry?: unknown }> =>
        import(`${pathToFileURL(modulePath).href}?v=${version}`),
      catch: (cause) =>
        new ChangelogCompileError({ message: `cannot load ${file}: ${String(cause)}`, file }),
    })
    const source = yield* Effect.try({
      try: () => config.contract.decodeEntrySource(module.entry),
      catch: (cause) =>
        new ChangelogCompileError({ message: `invalid entry ${file}: ${String(cause)}`, file }),
    })
    const scenePath = path.join(directory, `${id}${SCENE_SUFFIX}`)
    const hasScene = yield* fs.exists(scenePath)
    if (source.screenshot !== undefined && hasScene === false) {
      return yield* new ChangelogCompileError({
        message: `entry declares a screenshot but ${id}${SCENE_SUFFIX} is missing`,
        file,
      })
    }
    if (source.screenshot === undefined && hasScene === true) {
      return yield* new ChangelogCompileError({
        message: `${id}${SCENE_SUFFIX} exists but the entry declares no screenshot`,
        file,
      })
    }
    entries.push({ id, file, path: modulePath, scenePath, source })
  }
  for (const file of names) {
    if (file.endsWith(SCENE_SUFFIX) === false) continue
    const id = file.slice(0, -SCENE_SUFFIX.length)
    if (entries.some((entry) => entry.id === id) === false) {
      return yield* new ChangelogCompileError({ message: `scene without entry: ${file}`, file })
    }
  }
  return entries as ReadonlyArray<DiscoveredEntry<Text, Fields>>
})

/** Directories never part of build inputs. */
const SKIPPED_DIRECTORIES: Readonly<Record<string, true>> = {
  node_modules: true,
  '.git': true,
  dist: true,
  '.devenv': true,
  'test-results': true,
}

/** Product-relative files matching any glob, sorted. */
export const expandInputs = Effect.fn('changelog.expandInputs')(function* ({
  root,
  globs,
}: {
  readonly root: string
  readonly globs: ReadonlyArray<string>
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const patterns = globs.map(globToRegExp)
  const found: string[] = []
  const walk = (relative: string): Effect.Effect<void, PlatformError> =>
    Effect.gen(function* () {
      for (const name of yield* fs.readDirectory(path.join(root, relative))) {
        const child = relative === '' ? name : `${relative}/${name}`
        const info = yield* fs.stat(path.join(root, child))
        if (info.type === 'Directory') {
          if (Object.hasOwn(SKIPPED_DIRECTORIES, name) === false) yield* walk(child)
        } else if (info.type === 'File' && patterns.some((pattern) => pattern.test(child))) {
          found.push(child)
        }
      }
    })
  if (patterns.length > 0) yield* walk('')
  return found.toSorted()
})

/**
 * Freshness hash of one entry's screenshot: renderer version, render settings, the entry and
 * scene modules, and every declared build input. Any change means the pictures are stale.
 */
export const screenshotHash = Effect.fn('changelog.screenshotHash')(function* <Text, Fields>({
  config,
  entry,
}: {
  readonly config: ChangelogConfig<Text, Fields>
  readonly entry: DiscoveredEntry<Text, Fields>
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const hash = createHash('sha256')
  const { viewports, schemes, themes, inputs } = config.screenshots
  hash.update(JSON.stringify({ renderer: RENDERER_VERSION, viewports, schemes, themes }))
  const files = [
    path.relative(config.root, entry.path),
    path.relative(config.root, entry.scenePath),
    ...(yield* expandInputs({
      root: config.root,
      globs: [...inputs, ...(entry.source.screenshot?.inputs ?? [])],
    })),
  ]
  for (const file of new Set(files)) {
    hash.update(`\0${file.replaceAll('\\', '/')}\0`)
    hash.update(yield* fs.readFile(path.join(config.root, file)))
  }
  return `sha256:${hash.digest('hex')}`
})

/** The renderer's record for an entry, if any. */
export const readScreenshotRecord = Effect.fn('changelog.readScreenshotRecord')(function* <
  Text,
  Fields,
>({ config, id }: { readonly config: ChangelogConfig<Text, Fields>; readonly id: string }) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { screenshots } = yield* changelogPaths(config)
  const recordPath = path.join(screenshots, `${id}.json`)
  if ((yield* fs.exists(recordPath)) === false) return undefined
  const text = yield* fs.readFileString(recordPath)
  return yield* Effect.try({
    try: (): ScreenshotRecord => decodeScreenshotRecord(text),
    catch: (cause) =>
      new ChangelogCompileError({
        message: `invalid screenshot record ${id}.json: ${String(cause)}`,
        file: `${id}.json`,
      }),
  })
})

/** A file the build must ship beside the manifest. */
export interface ChangelogAsset {
  /** Output path relative to the build root, e.g. `changelog/<id>-phone-dark.<hash>.png`. */
  readonly fileName: string
  readonly bytes: Uint8Array
}

/**
 * Compiles the manifest for one build. Screenshot images get content-hashed public names so
 * they cache forever and never collide across builds.
 */
export const buildChangelog = Effect.fn('changelog.build')(function* <Text, Fields>({
  config,
  machineVersion,
  unrendered = 'fail',
}: {
  readonly config: ChangelogConfig<Text, Fields>
  readonly machineVersion: string
  /**
   * `omit` publishes entries whose screenshot is not rendered yet without one. Only for the
   * build the renderer itself drives; the changelog check still fails on unrendered images.
   */
  readonly unrendered?: 'fail' | 'omit' | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { screenshots } = yield* changelogPaths(config)
  const assets: ChangelogAsset[] = []
  const registrations: EntryRegistration<Text, Fields>[] = []
  for (const entry of yield* discoverEntries(config)) {
    if (entry.source.screenshot === undefined) {
      registrations.push({ file: entry.file, source: entry.source })
      continue
    }
    const record = yield* readScreenshotRecord({ config, id: entry.id })
    if (record === undefined) {
      if (unrendered === 'omit') {
        const { screenshot: _unrendered, ...source } = entry.source
        registrations.push({ file: entry.file, source: source as EntrySource<Text, Fields> })
        continue
      }
      return yield* new ChangelogCompileError({
        message: `entry declares a screenshot but none is rendered (run the changelog renderer): ${entry.file}`,
        file: entry.file,
      })
    }
    const images: PublishedImage[] = []
    for (const image of record.images) {
      const bytes = yield* fs.readFile(path.join(screenshots, image.file))
      const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 10)
      const extension = path.extname(image.file)
      const fileName = `${PUBLISHED_SCREENSHOT_PREFIX}${image.file.slice(0, -extension.length)}.${digest}${extension}`
      assets.push({ fileName, bytes })
      images.push({
        viewport: image.viewport,
        scheme: image.scheme,
        src: `./${fileName}`,
        width: image.width,
        height: image.height,
      })
    }
    registrations.push({ file: entry.file, source: entry.source, images })
  }
  const compiled = yield* Effect.try({
    try: () => compileChangelog({ contract: config.contract, registrations, machineVersion }),
    catch: (error) =>
      error instanceof ChangelogCompileError
        ? error
        : new ChangelogCompileError({ message: String(error) }),
  })
  return {
    manifest: compiled.manifest as Manifest<Text, Fields>,
    bytes: compiled.bytes,
    assets: assets as ReadonlyArray<ChangelogAsset>,
  }
})
