// The env manifest is the single source of truth for a provisioned demo env.
// `demo-env new` writes it; `list`, `rm`, `env --export`, and the links summary
// all read from it. The `--export` shell vars are a pure derivation of it.

export interface DemoRef {
  readonly id: string
  readonly url: string
}

export interface Manifest {
  readonly envId: string
  readonly label: string | null
  readonly createdAt: string
  readonly container: { readonly id: string; readonly title: string; readonly url: string }
  readonly envPage: { readonly id: string; readonly url: string; readonly title: string }
  readonly demos: {
    readonly md: {
      readonly dir: string
      readonly roadmap: DemoRef & { readonly file: string; readonly source: string }
      readonly spec: DemoRef & { readonly file: string; readonly source: string }
    }
    readonly sqlite: {
      readonly dbId: string
      readonly dsId: string
      readonly url: string
      readonly dir: string
      readonly sqlitePath: string
      readonly tracked: boolean
    }
    readonly schema: {
      readonly tasks: { readonly dbId: string; readonly dsId: string; readonly url: string }
      readonly people: { readonly dbId: string; readonly dsId: string; readonly url: string }
    }
    readonly react: { readonly pageId: string; readonly url: string }
  }
}

/**
 * Derive shell-sourceable env vars from a manifest. Consumed by both
 * `demo-env new --export` and `demo-env env <id> --export`, so the exported
 * surface is defined here once. `DEMO_PARENT_PAGE` is set to the env page id so
 * the existing per-demo screenplays (which read `DEMO_PARENT_PAGE`) keep working.
 */
export const manifestToEnvVars = (m: Manifest): Record<string, string> => {
  const d = m.demos
  return {
    DEMO_ENV_ID: m.envId,
    DEMO_ENV_PAGE_ID: m.envPage.id,
    DEMO_ENV_PAGE_URL: m.envPage.url,
    // Back-compat: existing demo scripts read DEMO_PARENT_PAGE.
    DEMO_PARENT_PAGE: m.envPage.id,
    // md demo
    DEMO_MD_DIR: d.md.dir,
    DEMO_MD_ROADMAP_ID: d.md.roadmap.id,
    DEMO_MD_ROADMAP_FILE: d.md.roadmap.file,
    DEMO_MD_SPEC_ID: d.md.spec.id,
    DEMO_MD_SPEC_FILE: d.md.spec.file,
    // sqlite demo
    DEMO_SQLITE_DB_ID: d.sqlite.dbId,
    DEMO_SQLITE_DS_ID: d.sqlite.dsId,
    DEMO_SQLITE_DIR: d.sqlite.dir,
    DEMO_SQLITE_PATH: d.sqlite.sqlitePath,
    // schema demo
    DEMO_TASKS_DB_ID: d.schema.tasks.dbId,
    DEMO_TASKS_DS_ID: d.schema.tasks.dsId,
    DEMO_PEOPLE_DB_ID: d.schema.people.dbId,
    DEMO_PEOPLE_DS_ID: d.schema.people.dsId,
    // react demo
    DEMO_REACT_PAGE_ID: d.react.pageId,
  }
}

/** Render env vars as `export KEY='value'` lines (safe single-quoting). */
export const renderExport = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'`)
    .join('\n')

export interface EnvLink {
  readonly label: string
  readonly url: string
}

/** The labeled browser-link list the presenter opens for the live demo. */
export const manifestToLinks = (m: Manifest): readonly EnvLink[] => [
  { label: 'Env page', url: m.envPage.url },
  { label: 'md · Launch roadmap', url: m.demos.md.roadmap.url },
  { label: 'md · API spec', url: m.demos.md.spec.url },
  { label: 'sqlite · Launch Tasks DB', url: m.demos.sqlite.url },
  { label: 'schema · Tasks DB', url: m.demos.schema.tasks.url },
  { label: 'schema · People DB', url: m.demos.schema.people.url },
  { label: 'react · target page', url: m.demos.react.url },
]
