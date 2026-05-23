import { canonicalizeMarkdown } from './hash.ts'
import type { MarkdownUpdateCommand } from './model.ts'

/** Contiguous line replacement needed to transform one Markdown body into another. */
export interface ChangedRange {
  readonly start: number
  readonly end: number
  readonly replacement: readonly string[]
}

/** Return the smallest contiguous line range that turns `baseLines` into `changedLines`. */
export const changedRange = (opts: {
  readonly baseLines: readonly string[]
  readonly changedLines: readonly string[]
}): ChangedRange => {
  const { baseLines, changedLines } = opts
  let prefix = 0
  while (
    prefix < baseLines.length &&
    prefix < changedLines.length &&
    baseLines[prefix] === changedLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < baseLines.length - prefix &&
    suffix < changedLines.length - prefix &&
    baseLines[baseLines.length - 1 - suffix] === changedLines[changedLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    start: prefix,
    end: baseLines.length - suffix,
    replacement: changedLines.slice(prefix, changedLines.length - suffix),
  }
}

const sameRange = (opts: { readonly left: ChangedRange; readonly right: ChangedRange }): boolean =>
  opts.left.start === opts.right.start && opts.left.end === opts.right.end

const sameLines = (opts: {
  readonly left: readonly string[]
  readonly right: readonly string[]
}): boolean =>
  opts.left.length === opts.right.length &&
  opts.left.every((line, index) => line === opts.right[index])

const applyRanges = (opts: {
  readonly baseLines: readonly string[]
  readonly rangesDescending: readonly ChangedRange[]
}): string => {
  const merged = [...opts.baseLines]
  for (const range of opts.rangesDescending) {
    merged.splice(range.start, range.end - range.start, ...range.replacement)
  }
  return merged.join('\n')
}

/** Merge non-overlapping local and remote line edits against a clean base body. */
export const tryMergeMarkdownBodies = (opts: {
  readonly baseBody: string
  readonly localBody: string
  readonly remoteBody: string
}): string | undefined => {
  const base = canonicalizeMarkdown(opts.baseBody)
  const local = canonicalizeMarkdown(opts.localBody)
  const remote = canonicalizeMarkdown(opts.remoteBody)

  if (local === remote) return local
  if (local === base) return remote
  if (remote === base) return local

  const baseLines = base.split('\n')
  const localLines = local.split('\n')
  const remoteLines = remote.split('\n')

  const localRange = changedRange({ baseLines, changedLines: localLines })
  const remoteRange = changedRange({ baseLines, changedLines: remoteLines })

  if (sameRange({ left: localRange, right: remoteRange }) === true) {
    return sameLines({ left: localRange.replacement, right: remoteRange.replacement }) === true
      ? local
      : undefined
  }

  if (localRange.end <= remoteRange.start) {
    return applyRanges({ baseLines, rangesDescending: [remoteRange, localRange] })
  }

  if (remoteRange.end <= localRange.start) {
    return applyRanges({ baseLines, rangesDescending: [localRange, remoteRange] })
  }

  return undefined
}

const countOccurrences = (opts: { readonly haystack: string; readonly needle: string }): number => {
  if (opts.needle.length === 0) return 0

  let count = 0
  let offset = 0
  while (true) {
    const index = opts.haystack.indexOf(opts.needle, offset)
    if (index === -1) return count
    count += 1
    offset = index + opts.needle.length
  }
}

/** Pick the narrowest Notion Markdown update command that preserves the desired body. */
export const planMarkdownUpdate = (opts: {
  readonly baseBody: string
  readonly remoteBody: string
  readonly desiredBody: string
}): MarkdownUpdateCommand => {
  const base = canonicalizeMarkdown(opts.baseBody)
  const remote = canonicalizeMarkdown(opts.remoteBody)
  const desired = canonicalizeMarkdown(opts.desiredBody)

  let prefix = 0
  while (
    prefix < base.length &&
    prefix < desired.length &&
    base.charCodeAt(prefix) === desired.charCodeAt(prefix)
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < base.length - prefix &&
    suffix < desired.length - prefix &&
    base.charCodeAt(base.length - 1 - suffix) === desired.charCodeAt(desired.length - 1 - suffix)
  ) {
    suffix += 1
  }

  const oldStr = base.slice(prefix, base.length - suffix)
  const newStr = desired.slice(prefix, desired.length - suffix)
  const isSafeTargetedUpdate =
    oldStr.length > 0 &&
    countOccurrences({ haystack: remote, needle: oldStr }) === 1 &&
    remote.replace(oldStr, newStr) === desired

  return isSafeTargetedUpdate === true
    ? {
        _tag: 'update_content',
        contentUpdates: [{ oldStr, newStr }],
        expectedMarkdown: desired,
      }
    : {
        _tag: 'replace_content',
        markdown: desired,
      }
}
