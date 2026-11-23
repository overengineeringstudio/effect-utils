import { Schema } from 'effect'

import {
  ColorScheme,
  ENTRY_FILENAME_PATTERN,
  NonEmptyTrimmedString,
  Pixels,
  type ChangelogContract,
  type Entry,
  type EntrySource,
  type Manifest,
  type PublishedImage,
} from './contract.ts'

/** Invalid filenames, duplicate ids, bad ring numbering or missing screenshots. */
export class ChangelogCompileError extends Schema.TaggedError<ChangelogCompileError>()(
  'ChangelogCompileError',
  { message: Schema.String, file: Schema.optional(Schema.String) },
) {}

/** Identity and date of an authored entry; both come only from its filename. */
export const identityFromFilename = (
  file: string,
): { readonly id: string; readonly date: string } => {
  const match = ENTRY_FILENAME_PATTERN.exec(file)
  const id = match?.groups?.id
  const date = match?.groups?.date
  if (id === undefined || date === undefined) {
    throw new ChangelogCompileError({
      message: `changelog entry must be named YYYY-MM-DD-slug.ts: ${file}`,
      file,
    })
  }
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new ChangelogCompileError({
      message: `changelog filename has an invalid calendar date: ${file}`,
      file,
    })
  }
  return { id, date }
}

/** One rendered image as recorded by the renderer beside the entry. */
export const ScreenshotRecordImage = Schema.Struct({
  viewport: NonEmptyTrimmedString,
  scheme: ColorScheme,
  /** Filename inside the screenshots directory. */
  file: NonEmptyTrimmedString,
  /** Crop size in CSS pixels; the PNG holds `deviceScaleFactor` times as many pixels. */
  width: Pixels,
  height: Pixels,
})

/** `<screenshots>/<id>.json`: what was rendered and from which inputs. */
export const ScreenshotRecord = Schema.Struct({
  /** Freshness hash of entry, scene, render settings and declared build inputs. */
  hash: NonEmptyTrimmedString,
  images: Schema.NonEmptyArray(ScreenshotRecordImage),
})
export type ScreenshotRecord = typeof ScreenshotRecord.Type

/** Strict decoder for screenshot records. */
export const decodeScreenshotRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(ScreenshotRecord),
  { onExcessProperty: 'error' },
)

/** One authored entry ready to compile. */
export interface EntryRegistration<Text, Fields> {
  /** Entry filename, e.g. `2026-11-22-wizard-trump.ts`. */
  readonly file: string
  readonly source: EntrySource<Text, Fields>
  /** Published images, already given their final URLs. Required iff the entry has a screenshot. */
  readonly images?: ReadonlyArray<PublishedImage> | undefined
}

/** Ring numbers run 1…n without gaps so captions read in order. */
const assertRingNumbers = ({ file, numbers }: { file: string; numbers: ReadonlyArray<number> }) => {
  const sorted = numbers.toSorted((a, b) => a - b)
  if (sorted.some((n, index) => n !== index + 1)) {
    throw new ChangelogCompileError({
      message: `ring annotations must be numbered 1…${numbers.length} without gaps or duplicates: ${file}`,
      file,
    })
  }
}

/** Validates, sorts (newest first) and stamps entries into a manifest and its JSON bytes. */
export const compileChangelog = <Text, Fields>({
  contract,
  registrations,
  machineVersion,
}: {
  readonly contract: ChangelogContract<Text, Fields>
  readonly registrations: ReadonlyArray<EntryRegistration<Text, Fields>>
  readonly machineVersion: string
}): { readonly manifest: Manifest<Text, Fields>; readonly bytes: string } => {
  const seen = new Set<string>()
  const entries = registrations
    .map(({ file, source, images }): Entry<Text, Fields> => {
      const identity = identityFromFilename(file)
      if (seen.has(identity.id)) {
        throw new ChangelogCompileError({
          message: `duplicate changelog entry id: ${identity.id}`,
          file,
        })
      }
      seen.add(identity.id)
      const { screenshot, ...rest } = contract.decodeEntrySource(source)
      if (screenshot === undefined) return { ...identity, ...rest } as Entry<Text, Fields>
      const rings = screenshot.annotations.flatMap((annotation) =>
        annotation.kind === 'ring' ? [annotation] : [],
      )
      assertRingNumbers({ file, numbers: rings.map(({ n }) => n) })
      const [first, ...more] = images ?? []
      if (first === undefined) {
        throw new ChangelogCompileError({
          message: `entry declares a screenshot but none is rendered: ${file}`,
          file,
        })
      }
      return {
        ...identity,
        ...rest,
        screenshot: {
          alt: screenshot.alt,
          images: [first, ...more],
          callouts: rings
            .toSorted((a, b) => a.n - b.n)
            .map(({ n, caption }) => ({ n, caption })),
        },
      } as Entry<Text, Fields>
    })
    .toSorted((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0))
  const manifest = contract.decodeManifest({
    schemaVersion: 1,
    product: contract.product,
    build: { machineVersion },
    entries,
  })
  return { manifest, bytes: `${contract.encodeManifestJson(manifest)}\n` }
}
