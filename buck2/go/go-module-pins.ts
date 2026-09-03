/**
 * Content-addressed Go module supply, derived from `go.mod`/`go.sum`.
 *
 * A member repo's `go/third-party/external-go-modules.bzl.genie.ts` is a
 * three-line call into this module; everything that has to be *right* lives
 * here, once, next to the Buck rules that consume it.
 *
 * The pin is a `sha256` over `<proxy>/<module>/@v/<version>.zip`, which the Go
 * module proxy protocol makes immutable for a `(module, version)` pair. It is
 * not a second, independent pin: `go mod download` fetches that exact URL and
 * authenticates the bytes against `go.sum`'s `h1:` dirhash and the checksum
 * database *before* we hash them, and the emitted table records both. So a
 * `sha256` mismatch at build time and an `h1:` mismatch at generation time are
 * the same fact observed at two moments.
 *
 * The module set is not ours either: it is whatever `go mod vendor` writes into
 * `vendor/modules.txt`, which is the file `go build -mod=vendor` verifies
 * against `go.mod`. Emitting that file verbatim is what lets the build assemble
 * a vendor tree out of archives without re-deriving Go's own module graph.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

/** Default public module proxy. Immutable per `(module, version)` by protocol. */
export const GO_MODULE_PROXY = 'https://proxy.golang.org'

export type GoModulePin = {
  readonly path: string
  readonly version: string
  readonly url: string
  readonly sha256: string
  readonly sizeBytes: number
  /** `go.sum`'s dirhash over the same zip, recorded so both pins are auditable. */
  readonly h1: string
}

export type GoModuleSupply = {
  /** Digest over the declared pin set (`go.mod` + `go.sum`), for the freshness gate. */
  readonly inputDigest: string
  readonly pins: ReadonlyArray<GoModulePin>
  /** Verbatim `go mod vendor` output; `go build -mod=vendor` verifies it. */
  readonly modulesTxt: string
}

/**
 * Go module proxy case-encoding: an uppercase letter becomes `!` plus its
 * lowercase form, so case-insensitive filesystems cannot collide two modules.
 */
export const escapeModulePath = (value: string): string =>
  [...value].map((char) => (char >= 'A' && char <= 'Z' ? `!${char.toLowerCase()}` : char)).join('')

const sha256Hex = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex')

const declaredPinDigest = (moduleDir: string): string => {
  const hash = createHash('sha256')
  for (const name of ['go.mod', 'go.sum']) {
    hash.update(name)
    hash.update('\0')
    hash.update(readFileSync(NodePath.join(moduleDir, name)))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

/** Module lines in `vendor/modules.txt` are `# <path> <version>`; `## …` are annotations. */
const parseModulesTxt = (text: string): ReadonlyArray<{ path: string; version: string }> =>
  text
    .split('\n')
    .filter((line) => line.startsWith('# ') === true && line.startsWith('## ') === false)
    .flatMap((line) => {
      const [path, version] = line.slice(2).split(/\s+/u)
      return path !== undefined && version !== undefined && version.startsWith('v') === true
        ? [{ path, version }]
        : []
    })

/**
 * Resolves the vendor build list and pins every module version in it.
 *
 * Runs in a scratch copy of the module directory so the member's worktree is
 * never mutated, and with `GOMODCACHE`/`GOPATH`/`GOCACHE` redirected so a
 * generator run cannot depend on — or poison — the developer's caches. The
 * module cache is written read-only, so it is torn down with `go clean
 * -modcache` rather than an ordinary recursive remove.
 */
export const resolveGoModuleSupply = (options: {
  readonly moduleDir: string
  readonly goBin?: string
  readonly proxy?: string
}): GoModuleSupply => {
  const { moduleDir, goBin = 'go', proxy = GO_MODULE_PROXY } = options
  const scratch = mkdtempSync(NodePath.join(tmpdir(), 'go-module-pins-'))
  try {
    const work = NodePath.join(scratch, 'module')
    mkdirSync(work)
    for (const name of ['go.mod', 'go.sum']) {
      cpSync(NodePath.join(moduleDir, name), NodePath.join(work, name))
    }
    // `go mod vendor` needs the first-party sources to know which packages are
    // reachable; only Go files matter and only at the module root.
    cpSync(moduleDir, work, {
      recursive: true,
      filter: (source) => source === moduleDir || source.endsWith('.go') === true,
    })

    const env = {
      ...process.env,
      GOPROXY: proxy,
      GOSUMDB: 'sum.golang.org',
      GOFLAGS: '-mod=mod',
      GOMODCACHE: NodePath.join(scratch, 'modcache'),
      GOPATH: NodePath.join(scratch, 'gopath'),
      GOCACHE: NodePath.join(scratch, 'gocache'),
      GOTOOLCHAIN: 'local',
      CGO_ENABLED: '0',
    }
    execFileSync(goBin, ['mod', 'vendor'], { cwd: work, env, stdio: 'pipe' })
    const modulesTxt = readFileSync(NodePath.join(work, 'vendor', 'modules.txt'), 'utf8')

    const pins = parseModulesTxt(modulesTxt).map(({ path, version }) => {
      const info = JSON.parse(
        execFileSync(goBin, ['mod', 'download', '-json', `${path}@${version}`], {
          cwd: work,
          env,
          encoding: 'utf8',
        }),
      ) as { Zip: string; Sum: string }
      const zip = readFileSync(info.Zip)
      return {
        path,
        version,
        url: `${proxy}/${escapeModulePath(path)}/@v/${escapeModulePath(version)}.zip`,
        sha256: sha256Hex(zip),
        sizeBytes: zip.byteLength,
        h1: info.Sum,
      }
    })

    return { inputDigest: declaredPinDigest(moduleDir), pins, modulesTxt }
  } finally {
    // Go writes the module cache read-only, so a plain recursive remove fails
    // with EACCES; `go clean -modcache` is Go's own teardown for it.
    execFileSync(goBin, ['clean', '-modcache'], {
      env: { ...process.env, GOMODCACHE: NodePath.join(scratch, 'modcache') },
      stdio: 'pipe',
    })
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Renders the Starlark pin table `buck2/go/defs.bzl:go_module_archives` consumes. */
export const renderGoModulePinTable = (supply: GoModuleSupply): string =>
  [
    '# Content-addressed Go module supply: every module version in the vendor build',
    '# list is one `http_archive` over the immutable `<proxy>/<module>/@v/<version>.zip`.',
    '# `sha256` was taken at generation time over the bytes the proxy served, after',
    "# `go mod download` authenticated the same bytes against `go.sum`'s `h1:` dirhash",
    '# and the checksum database; both pins are recorded.',
    '',
    `INPUT_DIGEST = "${supply.inputDigest}"`,
    '',
    'GO_MODULE_PINS = [',
    ...supply.pins.flatMap((pin) => [
      '    {',
      `        "path": "${pin.path}",`,
      `        "version": "${pin.version}",`,
      `        "url": "${pin.url}",`,
      `        "sha256": "${pin.sha256}",`,
      `        "size_bytes": ${pin.sizeBytes},`,
      `        "h1": "${pin.h1}",`,
      '    },',
    ]),
    ']',
    '',
  ].join('\n')
