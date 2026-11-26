import type { AnnotationTheme } from '../annotations.ts'
import type { ChangelogContract, ColorScheme } from '../contract.ts'

/** A viewport the renderer captures every screenshot at. */
export interface RenderViewport {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
}

/** Everything the compiler, check, Vite plugin and renderer need to know about a product. */
export interface ChangelogConfig<Text, Fields> {
  readonly contract: ChangelogContract<Text, Fields>
  /** Absolute product root (e.g. the app directory). All other paths are relative to it. */
  readonly root: string
  /** Directory of authored entries. Default `.changelog`. */
  readonly changelogDirectory?: string | undefined
  /** Product source globs that need an entry when they change (enforcement). */
  readonly sourcePaths: ReadonlyArray<string>
  readonly screenshots: {
    readonly viewports: ReadonlyArray<RenderViewport>
    readonly schemes: ReadonlyArray<ColorScheme>
    readonly themes: Readonly<Record<ColorScheme, AnnotationTheme>>
    /** Build inputs every screenshot depends on (globs), joined by each entry's own `inputs`. */
    readonly inputs: ReadonlyArray<string>
    /** Text burnt into images (captions); usually the product's default language. */
    readonly renderText: (text: Text) => string
  }
}

/** Default authored-entry directory, relative to the product root. */
export const DEFAULT_CHANGELOG_DIRECTORY = '.changelog'

/** Rendered images and their records live beside the entries. */
export const SCREENSHOTS_SUBDIRECTORY = 'screenshots'

/** Published screenshot URLs are relative to the app root: `changelog/<file>`. */
export const PUBLISHED_SCREENSHOT_PREFIX = 'changelog/'

/** Bumped whenever rendering output changes for identical inputs. */
export const RENDERER_VERSION = 1
