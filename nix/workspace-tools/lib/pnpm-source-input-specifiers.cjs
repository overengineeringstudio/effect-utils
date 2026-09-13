// Staged source-input `file:` specifier algebra, shared by every surface that
// writes, reads, or strips one.
//
// A source input is a package consumed from outside the Materialization Root.
// It is staged once under `.devenv/pnpm-source-inputs/current/<sourcePath>` and
// reached through a `file:` specifier.
//
// The single rule this module exists to enforce: pnpm resolves a `file:`
// specifier relative to the manifest that DECLARES it, so the only correct
// spelling for an importer at depth N is the importer-relative one. A
// root-relative spelling is correct only for the root importer, where the two
// happen to coincide. pnpm records the importer-relative form in
// `importers.<path>.dependencies.<name>.specifier`, so a root-relative
// declaration and the lockfile disagree for every nested importer — the
// manifest says `file:.devenv/...` while the lockfile says `file:../.devenv/...`
// — and a frozen install rejects the pair. Comparing or stripping on the
// root-relative literal has the same blind spot.
//
// Everything here is pure path algebra on POSIX-style workspace-relative paths.

const path = require('node:path')

/** Stable root-local path through which pnpm consumes the current source generation. */
const SOURCE_INPUT_STAGE_PATH = '.devenv/pnpm-source-inputs/current'

const FILE_PROTOCOL = 'file:'

/** POSIX-normalize a workspace-relative path, keeping `..` segments that escape the root. */
const normalizeRelative = (relPath) => {
  const normalized = path.posix.normalize(relPath)
  return normalized === './' ? '.' : normalized.replace(/\/$/, '')
}

/** Directory of an importer, as the lockfile spells it (`.` for the root importer). */
const importerDir = (importerPath) => {
  if (importerPath === undefined || importerPath === null || importerPath === '') return '.'
  return normalizeRelative(importerPath)
}

/** `true` when the specifier uses the `file:` protocol. */
const isFileSpecifier = (specifier) =>
  typeof specifier === 'string' && specifier.startsWith(FILE_PROTOCOL)

/** Path part of a `file:` specifier, or `null` for any other specifier. */
const fileSpecifierPath = (specifier) =>
  isFileSpecifier(specifier) === true ? specifier.slice(FILE_PROTOCOL.length) : null

/** `true` when `childPath` is `parentPath` or lives inside it. */
const isWithin = (parentPath, childPath) => {
  const relativePath = path.posix.relative(parentPath, childPath)
  return relativePath === '' || !(relativePath === '..' || relativePath.startsWith('../'))
}

/**
 * Resolve a specifier declared by `importerPath` to a workspace-root-relative
 * path, or `null` when it is not a `file:` specifier.
 */
const resolveFileSpecifier = ({ importerPath, specifier }) => {
  const specifierPath = fileSpecifierPath(specifier)
  if (specifierPath === null) return null
  if (path.posix.isAbsolute(specifierPath) === true) return specifierPath
  return normalizeRelative(path.posix.join(importerDir(importerPath), specifierPath))
}

/**
 * `true` when the specifier declared by `importerPath` targets the staged
 * source-input tree. Spelling-independent: it answers the question about the
 * resolved target, so the root-relative and importer-relative forms of the same
 * dependency both match.
 */
const isSourceInputSpecifier = ({ importerPath, specifier }) => {
  const resolved = resolveFileSpecifier({ importerPath, specifier })
  if (resolved === null) return false
  return isWithin(SOURCE_INPUT_STAGE_PATH, resolved)
}

/**
 * The specifier an importer must declare to reach `sourcePath` in the staged
 * tree. `sourcePath` is the source input's own workspace-relative path (for
 * example `repos/<repo>/packages/<name>`).
 */
const sourceInputSpecifierFor = ({ importerPath, sourcePath }) => {
  const target = path.posix.join(SOURCE_INPUT_STAGE_PATH, normalizeRelative(sourcePath))
  return `${FILE_PROTOCOL}${relativeSpecifierPath({ importerPath, target })}`
}

/**
 * `true` when a `file:` specifier points into the staged source-input tree, in
 * ANY spelling and without knowing the declaring importer. Use this to decide
 * whether a recorded value belongs to the source-input projection — for
 * example when stripping the projection out of a prepared tree — where the
 * same dependency may appear root-relative (`file:.devenv/...`, as declared on
 * the workspace root) or importer-relative (`file:../.devenv/...`, as pnpm
 * records it for a nested importer).
 */
const targetsSourceInputStage = (specifier) => {
  const specifierPath = fileSpecifierPath(specifier)
  if (specifierPath === null) return false
  const withoutParents = normalizeRelative(specifierPath).replace(/^(?:\.\.\/)+/, '')
  return isWithin(SOURCE_INPUT_STAGE_PATH, withoutParents)
}

/**
 * Re-spell an existing source-input specifier for the importer that declares
 * it. Returns the specifier unchanged when it is not a staged source input, so
 * callers can map over every dependency without classifying first.
 */
const relativizeSourceInputSpecifier = ({ importerPath, specifier }) => {
  const resolved = resolveFileSpecifier({ importerPath, specifier })
  if (resolved === null || isWithin(SOURCE_INPUT_STAGE_PATH, resolved) === false) return specifier
  return `${FILE_PROTOCOL}${relativeSpecifierPath({ importerPath, target: resolved })}`
}

/** Spell `target` (root-relative) as a path relative to `importerPath`. */
const relativeSpecifierPath = ({ importerPath, target }) => {
  const dir = importerDir(importerPath)
  if (dir === '.') return normalizeRelative(target)
  const relativePath = path.posix.relative(dir, normalizeRelative(target))
  return relativePath === '' ? '.' : relativePath
}

module.exports = {
  SOURCE_INPUT_STAGE_PATH,
  fileSpecifierPath,
  isFileSpecifier,
  isSourceInputSpecifier,
  isWithin,
  normalizeRelative,
  relativeSpecifierPath,
  relativizeSourceInputSpecifier,
  resolveFileSpecifier,
  sourceInputSpecifierFor,
  targetsSourceInputStage,
}
