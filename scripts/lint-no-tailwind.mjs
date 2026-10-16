#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const tailwindPackage = /^(?:tailwindcss(?:\/|$)|@tailwindcss(?:\/|$))/
const scriptFile = /\.(?:[cm]?[jt]sx?|astro|svelte|vue)$/
const styleFile = /\.(?:css|scss|sass|less|astro|svelte|vue)$/
const tailwindConfig = /(?:^|\/)tailwind\.config\.[cm]?[jt]s$/
const moduleReference =
  /(?<!@)\b(?:import\s*(?:\(\s*|(?:[^;'"]*?\s+from\s*)?)|export\s+(?:[^;'"]*?\s+from\s*)|require\s*\(\s*)['"]([^'"\n]+)['"]/g
const cssDirective =
  /(?:^|[;{}>])\s*(@(?:import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]|tailwind\b|apply\b))/gm
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

const lineAt = ({ text, index }) => {
  let line = 1
  for (let position = 0; position < index; position++) if (text[position] === '\n') line++
  return line
}

const maskComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\/|(^|\s)\/\/[^\n]*/gm, (comment) => comment.replace(/[^\n]/g, ' '))

const matchesPath = ({ pattern, path }) => {
  if (pattern === '**') return true
  const escaped = pattern
    .split('**')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${escaped}$`).test(path)
}

const exceptionFile = '.no-tailwind-exceptions.json'

/** Parse consumer-owned, checked-in exception declarations. */
export const parseTailwindExceptions = (content) => {
  const exceptions = JSON.parse(content)
  if (Array.isArray(exceptions) === false) throw new Error(`${exceptionFile} must contain an array`)
  return exceptions
}

/** Inspect candidate files for prohibited Tailwind dependencies and source use. */
export const inspectTailwind = ({ files, exceptions = [] }) => {
  for (const exception of exceptions) {
    if (
      typeof exception?.path !== 'string' ||
      typeof exception?.reason !== 'string' ||
      exception.reason.trim() === '' ||
      /^(?:\*\*|[^/]+(?:\/[^/]+)*\/\*\*)$/.test(exception.path) === false
    ) {
      throw new Error(
        `Invalid Tailwind exception ${JSON.stringify(exception)}: use a path ending in /** (or ** for the entire repository) and a nonempty reason`,
      )
    }
  }

  const violations = []
  const report = ({ path, line, message }) => {
    if (exceptions.some((exception) => matchesPath({ pattern: exception.path, path })) === false)
      violations.push(`${path}:${line}: ${message}`)
  }

  for (const { path, content } of files) {
    if (tailwindConfig.test(path) === true)
      report({ path, line: 1, message: 'Tailwind config; remove it and use StyleX' })
    if (path.endsWith('package.json') === true) {
      const manifest = JSON.parse(content)
      for (const section of dependencySections) {
        for (const name of Object.keys(manifest[section] ?? {})) {
          if (tailwindPackage.test(name) === true) {
            const sectionStart = content.indexOf(`"${section}"`)
            const location = content.indexOf(`"${name}"`, sectionStart)
            report({
              path,
              line: location < 0 ? 1 : lineAt({ text: content, index: location }),
              message: `${section}.${name} is a Tailwind dependency; remove it and use StyleX`,
            })
          }
        }
      }
    }
    if (scriptFile.test(path) === true) {
      const source = maskComments(content)
      // Match imports in source, not examples of imports inside ordinary strings.
      const strings = [...source.matchAll(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g)]
      for (const match of source.matchAll(moduleReference)) {
        if (
          strings.some(
            (string) =>
              string.index <= match.index && match.index < string.index + string[0].length,
          ) === true
        )
          continue
        if (tailwindPackage.test(match[1]) === true)
          report({
            path,
            line: lineAt({ text: content, index: match.index }),
            message: `Tailwind import ${match[1]}; replace it with StyleX`,
          })
      }
    }
    if (styleFile.test(path) === true) {
      const source = maskComments(content)
      for (const match of source.matchAll(cssDirective)) {
        if (match[2] === undefined || tailwindPackage.test(match[2]) === true) {
          report({
            path,
            line: lineAt({ text: content, index: match.index + match[0].indexOf(match[1]) }),
            message:
              'Tailwind CSS directive; replace it with StyleX or @overeng/stylex-tokens/preflight.css',
          })
        }
      }
    }
  }
  return violations
}

/** Inspect tracked and unignored local source selected by consumer Git pathspecs. */
export const checkRepository = ({ root, pathspecs = ['.'] }) => {
  let exceptions = []
  try {
    exceptions = parseTailwindExceptions(readFileSync(`${root}/${exceptionFile}`, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const files = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  if (files.status !== 0) throw new Error(`git ls-files failed: ${files.stderr.toString()}`)
  const paths = [...new Set(files.stdout.toString().split('\0').filter(Boolean))].toSorted()
  return inspectTailwind({
    files: paths
      .filter(
        (path) =>
          path.endsWith('package.json') === true ||
          scriptFile.test(path) === true ||
          styleFile.test(path) === true ||
          tailwindConfig.test(path) === true,
      )
      .filter((path) => lstatSync(`${root}/${path}`).isFile())
      .map((path) => ({ path, content: readFileSync(`${root}/${path}`, 'utf8') })),
    exceptions,
  })
}

if (
  process.argv[1] !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
) {
  try {
    const pathspecs = process.argv.slice(2)
    const violations = checkRepository({
      root: process.cwd(),
      pathspecs: pathspecs.length === 0 ? ['.'] : pathspecs,
    })
    if (violations.length > 0) {
      console.error(
        `Tailwind is forbidden by lint:check:no-tailwind (${violations.length} violation(s)):\n${violations.join('\n')}\nMigrate to StyleX; for approved exceptions, declare path-scoped { path, reason } entries in ${exceptionFile}.`,
      )
      process.exitCode = 1
    } else {
      console.log('No unexcepted Tailwind usage')
    }
  } catch (error) {
    console.error(`Tailwind guard failed: ${error.message}`)
    process.exitCode = 1
  }
}
