// demo-env — provision fresh, self-contained Notion demo environments.
//
// One `demo-env new` creates an isolated env page (under the shared
// "🧪 Demo Envs" container) holding everything all four demos need:
//   - md:        2 pages (Launch roadmap + API spec) with tracked .nmd stages
//   - sqlite:    1 typed DB + seed rows, tracked into a local <ds>.sqlite
//   - schema:    2 typed DBs (Tasks + People) with seed rows
//   - react:     1 target page
// plus a manifest.json (single source of truth) in a gitignored local dir. Two
// `new` calls never collide → safe for parallel harness runs.
//
// Run inside `devenv shell` (needs `ntn`, `notion`, NOTION_API_TOKEN on PATH).
//
// IMPORTANT stdout discipline: in `--export` mode ONLY `export KEY=…` lines go
// to stdout (so `eval "$(demo-env new --export)"` works); every progress log and
// the links list go to stderr. Without `--export`, the human summary goes to
// stdout.

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from './exec.ts'
import type { Manifest } from './manifest.ts'
import { manifestToEnvVars, manifestToLinks, renderExport } from './manifest.ts'
import { createDatabase, createPage, createRow, getChildren, ntnApi, pageUrl, trashPage } from './notion.ts'
import {
  PEOPLE_PROPERTIES,
  PEOPLE_ROWS,
  personRowProps,
  SQLITE_DB_TITLE,
  SQLITE_PROPERTIES,
  SQLITE_ROWS,
  sqliteRowProps,
  TASK_ROWS,
  taskRowProps,
  tasksProperties,
} from './seeds.ts'

// --- paths + constants -----------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const ENVS_DIR = join(REPO_ROOT, 'demo/.demo-envs')
const CONTAINER_STATE = join(ENVS_DIR, '.container.json')

/** The hub page the "🧪 Demo Envs" container lives under (decided w/ user). */
const HUB_PAGE_ID = '396e3d41f4a381e9a012c31197719adc'
const CONTAINER_TITLE = '🧪 Demo Envs'
const CONTAINER_EMOJI = '🧪'

const MD_SEED_DIR = join(REPO_ROOT, 'demo/md/seed')
const NMD_PLACEHOLDER_PARENT = '00000000-0000-4000-8000-000000000000'
const NOTION_MD_CLI = join(REPO_ROOT, 'packages/@overeng/notion-md/dist/src/cli.js')
const NOTION_BIN = process.env.NOTION_BIN ?? 'notion'

// Committed per-demo stage sources copied into each env's DEMO_<TOOL>_DIR so the
// presenter has a self-contained dir to `cd` into (Option B).
const SCHEMA_STAGE_DIR = join(REPO_ROOT, 'demo/schema/stage')
const REACT_STAGE_FILE = join(REPO_ROOT, 'demo/react/stage/page.tsx')
// node_modules the copied stages symlink to (repo-level pnpm install populates them).
const SCHEMA_NODE_MODULES = join(REPO_ROOT, 'packages/@overeng/notion-cli/node_modules')
const REACT_NODE_MODULES = join(REPO_ROOT, 'packages/@overeng/notion-react/node_modules')
// The 3-level-relative notion-react import in the committed page.tsx is rewritten
// to an absolute path on copy (the copied file lives at a different depth).
const REACT_MOD_RELATIVE = '../../../packages/@overeng/notion-react/src/mod.ts'
const REACT_MOD_ABSOLUTE = join(REPO_ROOT, 'packages/@overeng/notion-react/src/mod.ts')

/** All provisioning logs + link lists go here (never stdout). */
const log = (msg = ''): void => {
  process.stderr.write(`${msg}\n`)
}

// --- small utilities -------------------------------------------------------

const dashUuid = (raw: string): string => {
  const s = raw.replace(/-/g, '')
  if (s.length !== 32) return raw
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`
}

const envIdNow = (): string => {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const rand = Math.random().toString(16).slice(2, 6)
  return `env-${stamp}-${rand}`
}

const readNmdFrontmatter = async (file: string): Promise<{ pageId: string; url: string }> => {
  const text = await readFile(file, 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error(`no frontmatter in ${file}`)
  const fm = JSON.parse(m[1]) as { notion_md?: { page_id?: string; url?: string } }
  const pageId = fm.notion_md?.page_id ?? ''
  const url = fm.notion_md?.url ?? ''
  if (!pageId) throw new Error(`no page_id bound in ${file} after sync`)
  return { pageId, url: url || pageUrl(pageId) }
}

// --- container (idempotent) ------------------------------------------------

const ensureContainer = async (): Promise<{ id: string; title: string; url: string }> => {
  if (existsSync(CONTAINER_STATE)) {
    try {
      const cached = JSON.parse(await readFile(CONTAINER_STATE, 'utf8')) as {
        id: string
        url: string
      }
      if (cached.id) return { id: cached.id, title: CONTAINER_TITLE, url: cached.url }
    } catch {
      /* fall through and re-resolve */
    }
  }

  log(`resolving "${CONTAINER_TITLE}" container under hub ${HUB_PAGE_ID} ...`)
  const children = await getChildren(HUB_PAGE_ID)
  const found = children.find(
    (b) =>
      b.type === 'child_page' &&
      (b.child_page as { title?: string } | undefined)?.title === CONTAINER_TITLE,
  )

  let id: string
  let url: string
  if (found) {
    id = String(found.id)
    url = pageUrl(id)
    log(`  found existing container: ${url}`)
  } else {
    log('  container missing — creating it ...')
    const page = await createPage(HUB_PAGE_ID, CONTAINER_TITLE, CONTAINER_EMOJI)
    id = page.id
    url = page.url
    log(`  created container: ${url}`)
  }

  await mkdir(ENVS_DIR, { recursive: true })
  await writeFile(CONTAINER_STATE, JSON.stringify({ id, url, title: CONTAINER_TITLE }, null, 2))
  return { id, title: CONTAINER_TITLE, url }
}

// --- per-demo provisioning -------------------------------------------------

const provisionMd = async (
  envPageId: string,
  mdDir: string,
): Promise<Manifest['demos']['md']> => {
  await mkdir(mdDir, { recursive: true })
  const parent = dashUuid(envPageId)

  const bind = async (
    name: 'roadmap' | 'spec',
    source: 'shared' | 'remote',
  ): Promise<{ id: string; url: string; file: string; source: string }> => {
    const seed = await readFile(join(MD_SEED_DIR, `${name}.nmd`), 'utf8')
    const file = join(mdDir, `${name}.nmd`)
    await writeFile(file, seed.split(NMD_PLACEHOLDER_PARENT).join(parent))

    log(`  md: creating '${name}' page (source: ${source}) ...`)
    const synced = await run('node', [NOTION_MD_CLI, 'sync', file], { timeoutMs: 120_000 })
    if (synced.code !== 0) {
      throw new Error(`notion-md sync ${name} failed: ${synced.stderr || synced.stdout}`)
    }
    const { pageId, url } = await readNmdFrontmatter(file)
    const tracked = await run('node', [NOTION_MD_CLI, 'track', pageId, file, '--as', source], {
      timeoutMs: 120_000,
    })
    if (tracked.code !== 0) {
      throw new Error(`notion-md track ${name} failed: ${tracked.stderr || tracked.stdout}`)
    }
    return { id: pageId, url, file, source }
  }

  const roadmap = await bind('roadmap', 'shared')
  const spec = await bind('spec', 'remote')
  return { dir: mdDir, roadmap, spec }
}

const provisionSqlite = async (
  envPageId: string,
  sqliteDir: string,
  doTrack: boolean,
): Promise<Manifest['demos']['sqlite']> => {
  log('  sqlite: creating typed DB ...')
  const { dbId, dsId, url } = await createDatabase(
    envPageId,
    SQLITE_DB_TITLE,
    SQLITE_PROPERTIES,
  )
  log(`    db=${dbId} ds=${dsId}`)
  for (const row of SQLITE_ROWS) {
    await createRow(dsId, sqliteRowProps(row))
  }
  log(`    seeded ${SQLITE_ROWS.length} rows`)

  await mkdir(sqliteDir, { recursive: true })
  // The Node-backed replica runtime writes the tracked SQLite file at
  // `<workspace>/data/v1/<data-source-id>.sqlite` (keyed by DS id, not DB id).
  const sqlitePath = join(sqliteDir, 'data', 'v1', `${dsId}.sqlite`)

  let tracked = false
  if (doTrack) {
    log('  sqlite: notion db track (mode=local, ~1-2 min) ...')
    // Strip OTEL exporter vars to avoid a slow telemetry flush on establishment.
    const childEnv = { ...process.env }
    delete childEnv.OTEL_EXPORTER_OTLP_ENDPOINT
    delete childEnv.OTEL_EXPORTER_OTLP_PROTOCOL
    delete childEnv.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    // Public interface: `notion db track`. If the packaged runtime can't
    // establish the replica (see README limitations — upstream regression),
    // DEGRADE LOUDLY: the DB + rows still exist; only the local replica is
    // missing. Recorded as tracked:false so callers can detect + retry.
    const r = await run(
      NOTION_BIN,
      ['db', 'track', dsId, '.', '--mode', 'local', '--no-materialize-bodies'],
      { cwd: sqliteDir, env: childEnv, timeoutMs: 360_000 },
    ).catch((e: Error) => ({ code: -1, stdout: '', stderr: e.message }))
    if (r.code === 0 && existsSync(sqlitePath)) {
      tracked = true
      log(`    tracked -> ${sqlitePath}`)
    } else {
      log('  sqlite: WARNING — `notion db track` did not establish the local replica.')
      log('    The Notion DB + rows ARE created (usable for the demo); only the local')
      log('    SQLite replica is missing. Establish it later with:')
      log(`      cd ${sqliteDir} && notion db track ${dsId} . --mode local --no-materialize-bodies`)
      log(`    (${(r.stderr || r.stdout || 'no output').split('\n').slice(-1)[0].slice(0, 160)})`)
    }
  } else {
    log('  sqlite: --no-sqlite-track set — skipping local replica')
  }

  return { dbId, dsId, url, dir: sqliteDir, sqlitePath, tracked }
}

const provisionSchema = async (
  envPageId: string,
): Promise<Manifest['demos']['schema']> => {
  log('  schema: creating People DB ...')
  const people = await createDatabase(envPageId, 'People', PEOPLE_PROPERTIES, '👤')
  const peoplePageIds: string[] = []
  for (const p of PEOPLE_ROWS) {
    peoplePageIds.push(await createRow(people.dsId, personRowProps(p)))
  }
  log(`    People db=${people.dbId} (+${PEOPLE_ROWS.length} rows)`)

  log('  schema: creating Tasks DB ...')
  const tasks = await createDatabase(
    envPageId,
    'Tasks',
    tasksProperties(people.dsId),
    '✅',
  )
  for (let i = 0; i < TASK_ROWS.length; i++) {
    await createRow(tasks.dsId, taskRowProps(TASK_ROWS[i], peoplePageIds[i]))
  }
  log(`    Tasks db=${tasks.dbId} (+${TASK_ROWS.length} rows, Assignee → People)`)

  return {
    tasks: { dbId: tasks.dbId, dsId: tasks.dsId, url: tasks.url },
    people: { dbId: people.dbId, dsId: people.dsId, url: people.url },
  }
}

// --- per-demo stage dirs (Option B: a self-contained dir to `cd` into) ------

/** List git-tracked files under a dir (repo-relative), as absolute paths. */
const trackedFiles = async (dir: string): Promise<string[]> => {
  const r = await run('git', ['ls-files', '-z', '--', relative(REPO_ROOT, dir)], {
    cwd: REPO_ROOT,
  })
  if (r.code !== 0) throw new Error(`git ls-files failed for ${dir}: ${r.stderr}`)
  return r.stdout
    .split('\0')
    .filter(Boolean)
    .map((p) => join(REPO_ROOT, p))
}

/** Symlink `<destDir>/node_modules` at an absolute target (editor/runtime deps). */
const linkNodeModules = async (destDir: string, target: string): Promise<void> => {
  const link = join(destDir, 'node_modules')
  await rm(link, { recursive: true, force: true }).catch(() => {})
  await symlink(target, link)
}

/**
 * schema demo dir: copy the committed `demo/schema/stage/` sources (config,
 * use-schema, tsconfig, package.json) into DEMO_SCHEMA_DIR + symlink node_modules
 * for autocomplete. NOTE: the committed schema config still resolves ids from a
 * sibling `.demo-state/` — wiring it to `$DEMO_*` is deferred to the in-flight
 * schema split. This step only guarantees the dir + sources exist so the split
 * has a uniform DEMO_SCHEMA_DIR to land on.
 */
const provisionSchemaDir = async (schemaDir: string): Promise<void> => {
  await mkdir(schemaDir, { recursive: true })
  for (const src of await trackedFiles(SCHEMA_STAGE_DIR)) {
    await copyFile(src, join(schemaDir, relative(SCHEMA_STAGE_DIR, src)))
  }
  if (existsSync(SCHEMA_NODE_MODULES)) await linkNodeModules(schemaDir, SCHEMA_NODE_MODULES)
  log(`  schema: staged sources -> ${schemaDir}`)
}

/**
 * react demo dir: copy the committed `page.tsx` into DEMO_REACT_DIR, rewriting
 * the 3-level-relative notion-react import to an absolute path (the copy lives at
 * a different depth), and symlink node_modules so `bun run page.tsx` resolves its
 * deps. page.tsx reads the target page id from `$DEMO_REACT_PAGE_ID` and writes
 * its FsCache next to itself (inside this gitignored dir).
 */
const provisionReactDir = async (reactDir: string): Promise<void> => {
  await mkdir(reactDir, { recursive: true })
  const src = await readFile(REACT_STAGE_FILE, 'utf8')
  if (!src.includes(REACT_MOD_RELATIVE)) {
    throw new Error(
      `react: expected notion-react import '${REACT_MOD_RELATIVE}' not found in ${REACT_STAGE_FILE} ` +
        `(the import moved — update REACT_MOD_RELATIVE in demo-env.ts)`,
    )
  }
  await writeFile(join(reactDir, 'page.tsx'), src.split(REACT_MOD_RELATIVE).join(REACT_MOD_ABSOLUTE))
  if (existsSync(REACT_NODE_MODULES)) await linkNodeModules(reactDir, REACT_NODE_MODULES)
  log(`  react: staged page.tsx -> ${reactDir}`)
}

// --- manifest IO -----------------------------------------------------------

const manifestPath = (envId: string): string => join(ENVS_DIR, envId, 'manifest.json')

const readManifest = async (envId: string): Promise<Manifest> =>
  JSON.parse(await readFile(manifestPath(envId), 'utf8')) as Manifest

const listManifests = async (): Promise<Manifest[]> => {
  if (!existsSync(ENVS_DIR)) return []
  const entries = await readdir(ENVS_DIR, { withFileTypes: true })
  const out: Manifest[] = []
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('env-')) continue
    const p = manifestPath(e.name)
    if (existsSync(p)) {
      try {
        out.push(JSON.parse(await readFile(p, 'utf8')) as Manifest)
      } catch {
        /* skip corrupt manifest */
      }
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

// --- commands --------------------------------------------------------------

const printLinks = (m: Manifest): void => {
  log('')
  log('Open these in the browser for the live demo:')
  for (const { label, url } of manifestToLinks(m)) {
    log(`  ${label.padEnd(26)} ${url}`)
  }
}

const cmdNew = async (opts: {
  label: string | null
  exportMode: boolean
  sqliteTrack: boolean
}): Promise<void> => {
  const envId = envIdNow()
  const envDir = join(ENVS_DIR, envId)
  const container = await ensureContainer()

  log(`\nprovisioning ${envId}${opts.label ? ` (label: ${opts.label})` : ''} ...`)
  const envTitle = opts.label ? `${envId} — ${opts.label}` : envId
  const envPage = await createPage(container.id, envTitle, '🧫')
  log(`env page: ${envPage.url}`)

  await mkdir(envDir, { recursive: true })

  // Sequential provisioning (one env at a time keeps us under Notion rate limits).
  const md = await provisionMd(envPage.id, join(envDir, 'md'))
  const sqlite = await provisionSqlite(envPage.id, join(envDir, 'sqlite'), opts.sqliteTrack)
  const schema = await provisionSchema(envPage.id)
  const schemaDir = join(envDir, 'schema')
  await provisionSchemaDir(schemaDir)
  log('  react: creating target page ...')
  const react = await createPage(envPage.id, `Q2 Launch Plan — react demo (${envId})`, '🚀')
  const reactDir = join(envDir, 'react')
  await provisionReactDir(reactDir)

  const manifest: Manifest = {
    envId,
    label: opts.label,
    createdAt: new Date().toISOString(),
    container,
    envPage: { id: envPage.id, url: envPage.url, title: envTitle },
    demos: {
      md,
      sqlite,
      schema: { dir: schemaDir, ...schema },
      react: { dir: reactDir, pageId: react.id, url: react.url },
    },
  }
  await writeFile(manifestPath(envId), JSON.stringify(manifest, null, 2))
  log(`\nmanifest: ${manifestPath(envId)}`)

  if (opts.exportMode) {
    // stdout: ONLY the eval-able export lines. Everything else went to stderr.
    printLinks(manifest)
    process.stdout.write(`${renderExport(manifestToEnvVars(manifest))}\n`)
  } else {
    // Human summary to stdout.
    const links = manifestToLinks(manifest)
    const lines = [
      '',
      `env id:      ${envId}`,
      `env page:    ${envPage.url}`,
      `manifest:    ${manifestPath(envId)}`,
      '',
      'Demo links:',
      ...links.map(({ label, url }) => `  ${label.padEnd(26)} ${url}`),
      '',
      'To load this env into your shell:',
      `  eval "$(demo/env/demo-env env ${envId} --export)"`,
      '',
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
  }
}

const cmdList = async (): Promise<void> => {
  const envs = await listManifests()
  if (envs.length === 0) {
    process.stdout.write('no local demo envs\n')
    return
  }
  const rows = envs.map((m) => [
    m.envId,
    m.label ?? '-',
    m.createdAt,
    m.envPage.url,
  ])
  const out = rows
    .map((r) => `${r[0].padEnd(24)} ${r[1].padEnd(16)} ${r[2].padEnd(26)} ${r[3]}`)
    .join('\n')
  process.stdout.write(`${out}\n`)
}

const cmdRm = async (envId: string): Promise<void> => {
  const dir = join(ENVS_DIR, envId)
  if (!existsSync(manifestPath(envId))) {
    throw new Error(`no local env "${envId}" (nothing in ${dir})`)
  }
  const m = await readManifest(envId)
  log(`trashing env page ${m.envPage.id} (cascades to children) ...`)
  await trashPage(m.envPage.id)
  await rm(dir, { recursive: true, force: true })
  process.stdout.write(`removed ${envId} (page trashed, local dir deleted)\n`)
}

const parseDuration = (s: string): number => {
  const m = s.match(/^(\d+)([smhd])$/)
  if (!m) throw new Error(`bad --older-than "${s}" (use e.g. 30m, 2h, 1d)`)
  const n = Number(m[1])
  const unit = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as 's' | 'm' | 'h' | 'd']
  return n * unit
}

const cmdGc = async (olderThan: string): Promise<void> => {
  const cutoff = Date.now() - parseDuration(olderThan)
  const envs = await listManifests()
  const stale = envs.filter((m) => new Date(m.createdAt).getTime() < cutoff)
  if (stale.length === 0) {
    process.stdout.write(`no envs older than ${olderThan}\n`)
    return
  }
  for (const m of stale) {
    try {
      await cmdRm(m.envId)
    } catch (e) {
      log(`gc: failed to remove ${m.envId}: ${(e as Error).message}`)
    }
  }
}

const cmdEnv = async (envId: string, exportMode: boolean): Promise<void> => {
  const m = await readManifest(envId)
  if (exportMode) {
    printLinks(m)
    process.stdout.write(`${renderExport(manifestToEnvVars(m))}\n`)
  } else {
    const lines = [
      `env id:   ${m.envId}`,
      `env page: ${m.envPage.url}`,
      `manifest: ${manifestPath(envId)}`,
      '',
      'Demo links:',
      ...manifestToLinks(m).map(({ label, url }) => `  ${label.padEnd(26)} ${url}`),
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
  }
}

// --- arg parsing + dispatch ------------------------------------------------

const USAGE = `demo-env — provision fresh Notion demo environments

Usage:
  demo-env new [--label <name>] [--export] [--no-sqlite-track]
  demo-env env <id> [--export]
  demo-env list
  demo-env rm <id>
  demo-env gc [--older-than <dur>]   (dur: 30m, 2h, 1d; default 2h)

Run inside 'devenv shell' (needs ntn, notion, NOTION_API_TOKEN).
With --export: 'eval "$(demo-env new --export)"' sets DEMO_* vars in your shell.`

const getFlag = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const hasFlag = (argv: string[], name: string): boolean => argv.includes(name)

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const positional = argv.slice(1).filter((a) => !a.startsWith('--'))

  switch (cmd) {
    case 'new':
      await cmdNew({
        label: getFlag(argv, '--label') ?? null,
        exportMode: hasFlag(argv, '--export'),
        sqliteTrack: !hasFlag(argv, '--no-sqlite-track'),
      })
      break
    case 'env': {
      const id = positional[0]
      if (!id) throw new Error('env: <id> required')
      await cmdEnv(id, hasFlag(argv, '--export'))
      break
    }
    case 'list':
      await cmdList()
      break
    case 'rm': {
      const id = positional[0]
      if (!id) throw new Error('rm: <id> required')
      await cmdRm(id)
      break
    }
    case 'gc':
      await cmdGc(getFlag(argv, '--older-than') ?? '2h')
      break
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(`${USAGE}\n`)
      break
    default:
      log(`unknown command: ${cmd}\n`)
      process.stdout.write(`${USAGE}\n`)
      process.exitCode = 1
  }
}

main().catch((e) => {
  log(`\nerror: ${(e as Error).message}`)
  process.exitCode = 1
})
