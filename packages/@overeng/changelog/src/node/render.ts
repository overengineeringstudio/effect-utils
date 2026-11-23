import { pathToFileURL } from 'node:url'

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

import { cropRect, drawAnnotations, type Box, type PlacedAnnotation } from '../annotations.ts'
import { ChangelogCompileError, type ScreenshotRecord } from '../compiler.ts'
import type { ColorScheme } from '../contract.ts'
import type { ChangelogConfig, RenderViewport } from './config.ts'
import {
  changelogPaths,
  discoverEntries,
  readScreenshotRecord,
  screenshotHash,
  type DiscoveredEntry,
} from './load.ts'

/**
 * The slice of Playwright's `Page` the renderer uses. Structural, so any Playwright version
 * (and the product's own test fixtures) can supply pages without a shared dependency.
 */
export interface RenderPage {
  emulateMedia(options: {
    readonly colorScheme?: ColorScheme
    readonly reducedMotion?: 'reduce'
  }): Promise<void>
  locator(selector: string): {
    first(): {
      waitFor(options?: { readonly state?: 'visible'; readonly timeout?: number }): Promise<void>
      boundingBox(): Promise<Box | null>
    }
  }
  evaluate(pageFunction: (svg: string) => unknown, arg: string): Promise<unknown>
  screenshot(options: {
    readonly clip: Box
    readonly animations?: 'disabled'
    readonly caret?: 'hide'
    readonly type?: 'png'
  }): Promise<Uint8Array>
  context(): { close(): Promise<void> }
}

/** What a scene receives: the product decides how a page is created (fixtures, devices). */
export interface SceneArgs<Browser> {
  readonly browser: Browser
  readonly viewport: RenderViewport
  readonly scheme: ColorScheme
}

/**
 * `<id>.scene.ts` default-exports or exports `scene`: it opens a page in the given viewport and
 * colour scheme and drives the app into the state worth showing. The renderer captures it and
 * closes the page's context.
 */
export type ChangelogScene<Browser> = (args: SceneArgs<Browser>) => Promise<RenderPage>

const injectOverlay = (svg: string) => {
  document.querySelector('[data-changelog-annotations]')?.remove()
  document.body.insertAdjacentHTML('beforeend', svg)
}

const boxOf = Effect.fn('changelog.render.boxOf')(function* ({
  page,
  selector,
  file,
}: {
  readonly page: RenderPage
  readonly selector: string
  readonly file: string
}) {
  const locator = page.locator(selector).first()
  const box = yield* Effect.tryPromise({
    try: async () => {
      await locator.waitFor({ state: 'visible', timeout: 15_000 })
      return locator.boundingBox()
    },
    catch: (cause) =>
      new ChangelogCompileError({
        message: `annotation target not visible: ${selector} (${String(cause)})`,
        file,
      }),
  })
  if (box === null) {
    return yield* new ChangelogCompileError({ message: `target has no box: ${selector}`, file })
  }
  return box
})

/** Renders one entry in one viewport and scheme; returns PNG bytes and the CSS crop size. */
const renderOne = Effect.fn('changelog.render.one')(function* <Text, Fields, Browser>({
  config,
  entry,
  scene,
  browser,
  viewport,
  scheme,
}: {
  readonly config: ChangelogConfig<Text, Fields>
  readonly entry: DiscoveredEntry<Text, Fields>
  readonly scene: ChangelogScene<Browser>
  readonly browser: Browser
  readonly viewport: RenderViewport
  readonly scheme: ColorScheme
}) {
  const screenshot = entry.source.screenshot!
  const page = yield* Effect.tryPromise({
    try: () => scene({ browser, viewport, scheme }),
    catch: (cause) =>
      new ChangelogCompileError({ message: `scene failed: ${String(cause)}`, file: entry.file }),
  })
  return yield* Effect.gen(function* () {
    yield* Effect.promise(() => page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' }))
    const placed: PlacedAnnotation[] = []
    for (const annotation of screenshot.annotations) {
      const box = yield* boxOf({ page, selector: annotation.target, file: entry.file })
      placed.push({
        box,
        annotation:
          annotation.kind === 'ring'
            ? { ...annotation, caption: config.screenshots.renderText(annotation.caption) }
            : annotation.kind === 'caption'
              ? { ...annotation, text: config.screenshots.renderText(annotation.text) }
              : annotation,
      })
    }
    const { crop } = screenshot
    const base =
      'rect' in crop
        ? crop.rect
        : yield* Effect.map(
            boxOf({ page, selector: crop.target, file: entry.file }),
            (box): Box => {
              const padding = crop.padding ?? 16
              return {
                x: box.x - padding,
                y: box.y - padding,
                width: box.width + padding * 2,
                height: box.height + padding * 2,
              }
            },
          )
    const clip = cropRect({ base, viewport })
    const svg = drawAnnotations({
      placed,
      theme: config.screenshots.themes[scheme],
      seed: `${entry.id}:${viewport.name}`,
      viewport,
    })
    yield* Effect.promise(() => page.evaluate(injectOverlay, svg))
    const bytes = yield* Effect.promise(() =>
      page.screenshot({ clip, animations: 'disabled', caret: 'hide', type: 'png' }),
    )
    return { bytes, width: clip.width, height: clip.height }
  }).pipe(Effect.ensuring(Effect.promise(() => page.context().close())))
})

/**
 * Renders every screenshot entry (or only `ids`) at each configured viewport and scheme and
 * writes `<id>-<viewport>-<scheme>.png` plus the `<id>.json` record carrying the freshness hash.
 * With `onlyStale`, entries whose record already matches their inputs are skipped.
 */
export const renderScreenshots = Effect.fn('changelog.render')(function* <Text, Fields, Browser>({
  config,
  browser,
  ids,
  onlyStale = false,
}: {
  readonly config: ChangelogConfig<Text, Fields>
  readonly browser: Browser
  readonly ids?: ReadonlyArray<string> | undefined
  readonly onlyStale?: boolean | undefined
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { screenshots } = yield* changelogPaths(config)
  yield* fs.makeDirectory(screenshots, { recursive: true })
  const rendered: string[] = []
  for (const entry of yield* discoverEntries(config)) {
    if (entry.source.screenshot === undefined) continue
    if (ids !== undefined && ids.includes(entry.id) === false) continue
    const hash = yield* screenshotHash({ config, entry })
    const recordPath = path.join(screenshots, `${entry.id}.json`)
    if (onlyStale === true) {
      const current = yield* readScreenshotRecord({ config, id: entry.id })
      if (current?.hash === hash) continue
    }
    const module = yield* Effect.tryPromise({
      try: (): Promise<{ readonly scene?: ChangelogScene<Browser> }> =>
        import(pathToFileURL(entry.scenePath).href),
      catch: (cause) =>
        new ChangelogCompileError({ message: `cannot load scene: ${String(cause)}`, file: entry.file }),
    })
    const scene = module.scene
    if (typeof scene !== 'function') {
      return yield* new ChangelogCompileError({
        message: `${entry.id}.scene.ts must export \`scene\``,
        file: entry.file,
      })
    }
    const images: ScreenshotRecord['images'][number][] = []
    for (const viewport of config.screenshots.viewports) {
      for (const scheme of config.screenshots.schemes) {
        const image = yield* renderOne({ config, entry, scene, browser, viewport, scheme })
        const file = `${entry.id}-${viewport.name}-${scheme}.png`
        yield* fs.writeFile(path.join(screenshots, file), image.bytes)
        images.push({ viewport: viewport.name, scheme, file, width: image.width, height: image.height })
      }
    }
    const [first, ...rest] = images
    if (first === undefined) {
      return yield* new ChangelogCompileError({
        message: 'configure at least one screenshot viewport and scheme',
        file: entry.file,
      })
    }
    const record: ScreenshotRecord = { hash, images: [first, ...rest] }
    yield* fs.writeFileString(recordPath, `${JSON.stringify(record)}\n`)
    rendered.push(entry.id)
  }
  return rendered as ReadonlyArray<string>
})
