import { Schema } from 'effect'

/**
 * Structured changelog contract shared by every product.
 *
 * An authored entry is one module named `YYYY-MM-DD-slug.ts`; the filename is its immutable
 * identity and its only date. Products extend the shared fields through
 * {@link makeChangelogContract}: they choose the text type (a plain string, or one string per
 * language) and add product fields (game tags, contributors, …). The compiler publishes one
 * versioned manifest per build, stamped with the build's canonical `machineVersion`.
 */

/** A non-empty string without surrounding whitespace. */
export const NonEmptyTrimmedString = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isTrimmed()),
).annotate({ identifier: 'Changelog.NonEmptyTrimmedString' })

/** `YYYY-MM-DD-slug`, lowercase kebab slug. */
export const ENTRY_ID_PATTERN = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Authored entry module filename: `YYYY-MM-DD-slug.ts`. Scenes (`*.scene.ts`) never match. */
export const ENTRY_FILENAME_PATTERN =
  /^(?<id>(?<date>\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*)\.ts$/u

/** Entry id: the entry filename without `.ts` (`YYYY-MM-DD-slug`). */
export const ChangelogEntryId = NonEmptyTrimmedString.pipe(
  Schema.check(Schema.isPattern(ENTRY_ID_PATTERN)),
).annotate({ identifier: 'Changelog.EntryId' })

/** Calendar date of an entry, `YYYY-MM-DD`. */
export const ChangelogDate = NonEmptyTrimmedString.pipe(
  Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
).annotate({ identifier: 'Changelog.Date' })

/** Positive whole pixels. */
export const Pixels = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))

/** Colour schemes every screenshot is rendered in. */
export const ColorScheme = Schema.Literals(['light', 'dark'])
export type ColorScheme = typeof ColorScheme.Type

/**
 * A Playwright selector for the element an annotation points at
 * (e.g. `[data-testid="wizard-bid-trump"]`). The first match is used.
 */
export const Target = NonEmptyTrimmedString.annotate({ identifier: 'Changelog.Target' })

const Offset = Schema.Struct({ dx: Schema.Finite, dy: Schema.Finite })

/** Crop around a target (with padding in CSS pixels) or an explicit viewport rectangle. */
export const ScreenshotCrop = Schema.Union([
  Schema.Struct({
    target: Target,
    padding: Schema.optional(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  }),
  Schema.Struct({
    rect: Schema.Struct({
      x: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      y: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      width: Pixels,
      height: Pixels,
    }),
  }),
]).annotate({ identifier: 'Changelog.ScreenshotCrop' })
export type ScreenshotCrop = typeof ScreenshotCrop.Type

/** Hand-drawn mark styles. */
export const MarkStyle = Schema.Literals(['underline', 'highlight', 'scribble'])
export type MarkStyle = typeof MarkStyle.Type

/** Side of a target a caption is placed on. */
export const CaptionSide = Schema.Literals(['top', 'bottom', 'left', 'right'])
export type CaptionSide = typeof CaptionSide.Type

const Padding = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/** Numbered ring; its caption is published with the manifest, not burnt into the image. */
export interface RingAnnotation<Text> {
  readonly kind: 'ring'
  readonly n: number
  readonly target: string
  readonly caption: Text
  readonly padding?: number | undefined
}

/** Hand-drawn arrow from an offset (CSS px from the target's centre) to the target's edge. */
export interface ArrowAnnotation {
  readonly kind: 'arrow'
  readonly target: string
  readonly from: { readonly dx: number; readonly dy: number }
}

/** Freehand mark on a target. */
export interface MarkAnnotation {
  readonly kind: 'mark'
  readonly target: string
  readonly style: MarkStyle
}

/** Short text burnt into the image beside a target. */
export interface CaptionAnnotation<Text> {
  readonly kind: 'caption'
  readonly target: string
  readonly side: CaptionSide
  readonly text: Text
}

/** Any screenshot annotation an entry can draw over a scene. */
export type Annotation<Text> =
  | RingAnnotation<Text>
  | ArrowAnnotation
  | MarkAnnotation
  | CaptionAnnotation<Text>

/** Screenshot request inside an authored entry. The scene lives beside it as `<id>.scene.ts`. */
export interface ScreenshotSource<Text> {
  readonly alt: Text
  readonly crop: ScreenshotCrop
  readonly annotations: ReadonlyArray<Annotation<Text>>
  /**
   * Globs relative to the product root naming the build inputs the picture depends on. Their
   * bytes join the freshness hash with the entry, its scene and the product's shared inputs.
   */
  readonly inputs?: ReadonlyArray<string> | undefined
}

/** Screenshot as published: lazily loaded images plus the ring captions in number order. */
export interface PublishedScreenshot<Text> {
  readonly alt: Text
  readonly images: readonly [PublishedImage, ...PublishedImage[]]
  readonly callouts: ReadonlyArray<{ readonly n: number; readonly caption: Text }>
}

/** Authored payload of one entry module (`export const entry = …`). */
export type EntrySource<Text, Fields> = {
  readonly title: Text
  readonly summary: Text
  readonly screenshot?: ScreenshotSource<Text> | undefined
} & Fields

/** Published entry with its filename-derived identity and date. */
export type Entry<Text, Fields> = {
  readonly id: string
  readonly date: string
  readonly title: Text
  readonly summary: Text
  readonly screenshot?: PublishedScreenshot<Text> | undefined
} & Fields

/** Versioned manifest shipped beside each build. */
export interface Manifest<Text, Fields> {
  readonly schemaVersion: 1
  readonly product: string
  /** Opaque canonical build identity; never parsed or reconstructed here. */
  readonly build: { readonly machineVersion: string }
  readonly entries: ReadonlyArray<Entry<Text, Fields>>
}

const makeAnnotation = <Text>(text: Schema.Codec<Text, unknown>) =>
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('ring'),
      n: Pixels,
      target: Target,
      caption: text,
      padding: Schema.optional(Padding),
    }),
    Schema.Struct({ kind: Schema.Literal('arrow'), target: Target, from: Offset }),
    Schema.Struct({ kind: Schema.Literal('mark'), target: Target, style: MarkStyle }),
    Schema.Struct({ kind: Schema.Literal('caption'), target: Target, side: CaptionSide, text }),
  ])

const makeScreenshotSource = <Text>(text: Schema.Codec<Text, unknown>) =>
  Schema.Struct({
    alt: text,
    crop: ScreenshotCrop,
    annotations: Schema.Array(makeAnnotation(text)),
    inputs: Schema.optional(Schema.Array(NonEmptyTrimmedString)),
  })

const makePublishedScreenshot = <Text>(text: Schema.Codec<Text, unknown>) =>
  Schema.Struct({
    alt: text,
    images: Schema.NonEmptyArray(PublishedImage),
    callouts: Schema.Array(Schema.Struct({ n: Pixels, caption: text })),
  })

/** One rendered image, cropped to a fixed size so readers can reserve its box. */
export const PublishedImage = Schema.Struct({
  viewport: NonEmptyTrimmedString,
  scheme: ColorScheme,
  src: NonEmptyTrimmedString,
  width: Pixels,
  height: Pixels,
}).annotate({ identifier: 'Changelog.PublishedImage' })
export type PublishedImage = typeof PublishedImage.Type

/** Strict decoding: unknown authored or published fields are rejected rather than stripped. */
export const STRICT_SCHEMA_OPTIONS = { onExcessProperty: 'error' } as const

/** The product extension point. */
export interface ChangelogProduct<Text, Fields extends Schema.Struct.Fields> {
  /** Stable product name written into every manifest. */
  readonly product: string
  /** Schema for titles, summaries, alt texts and captions (a string, or one per language). */
  readonly text: Schema.Codec<Text, unknown>
  /** Additional authored and published fields (tags, contributors, …). */
  readonly fields: Fields
}

/** One product's changelog schemas and strict codecs. */
export interface ChangelogContract<Text, Fields> {
  readonly product: string
  readonly EntrySource: Schema.Codec<EntrySource<Text, Fields>, unknown>
  readonly ScreenshotSource: Schema.Codec<ScreenshotSource<Text>, unknown>
  readonly Entry: Schema.Codec<Entry<Text, Fields>, unknown>
  readonly Manifest: Schema.Codec<Manifest<Text, Fields>, unknown>
  /** Strict authored-source decoder; throws on unknown or invalid fields. */
  readonly decodeEntrySource: (input: unknown) => EntrySource<Text, Fields>
  /** Strict manifest decoder for the browser boundary; throws on unknown or invalid fields. */
  readonly decodeManifest: (input: unknown) => Manifest<Text, Fields>
  /** Canonical JSON bytes of a manifest. */
  readonly encodeManifestJson: (manifest: Manifest<Text, Fields>) => string
}

/** Builds the authored-entry, published-entry and manifest schemas for one product. */
export const makeChangelogContract = <Text, const Fields extends Schema.Struct.Fields>({
  product,
  text,
  fields,
}: ChangelogProduct<Text, Fields>): ChangelogContract<Text, Schema.Struct.Type<Fields>> => {
  const EntrySource = Schema.Struct({
    title: text,
    summary: text,
    ...fields,
    screenshot: Schema.optional(makeScreenshotSource(text)),
  }) as unknown as Schema.Codec<EntrySource<Text, Schema.Struct.Type<Fields>>, unknown>
  const Entry = Schema.Struct({
    id: ChangelogEntryId,
    date: ChangelogDate,
    title: text,
    summary: text,
    ...fields,
    screenshot: Schema.optional(makePublishedScreenshot(text)),
  }) as unknown as Schema.Codec<Entry<Text, Schema.Struct.Type<Fields>>, unknown>
  const Manifest = Schema.Struct({
    schemaVersion: Schema.Literal(1),
    product: Schema.Literal(product),
    build: Schema.Struct({ machineVersion: NonEmptyTrimmedString }),
    entries: Schema.Array(Entry),
  }) as unknown as Schema.Codec<Manifest<Text, Schema.Struct.Type<Fields>>, unknown>
  const encodeManifestJson = Schema.encodeSync(Schema.fromJsonString(Manifest))
  return {
    product,
    EntrySource,
    ScreenshotSource: makeScreenshotSource(text) as unknown as Schema.Codec<
      ScreenshotSource<Text>,
      unknown
    >,
    Entry,
    Manifest,
    decodeEntrySource: Schema.decodeUnknownSync(EntrySource, STRICT_SCHEMA_OPTIONS),
    decodeManifest: Schema.decodeUnknownSync(Manifest, STRICT_SCHEMA_OPTIONS),
    encodeManifestJson,
  }
}

/** Public filename of the versioned manifest beside each build. */
export const CHANGELOG_MANIFEST_FILENAME = 'changelog.v1.json' as const
