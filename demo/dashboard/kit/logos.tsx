/**
 * logos.tsx — official technology brand marks as inline React SVG.
 *
 * ZERO external requests: every mark is an inline `<svg>` path — no CDN, no
 * `<img>`, no web font. Safe for the SSG explainers (build-time, no client
 * runtime) AND the control dashboard's React tree, and safe to record (nothing
 * hits the network mid-take).
 *
 * Theming:
 *   • Monochrome marks default to `fill="currentColor"`, so they inherit the
 *     surrounding text color and re-theme automatically in light/dark.
 *   • Pass `brand` to paint the OFFICIAL brand color instead — meant for the
 *     marks that read better in color (TypeScript blue, React cyan). For the
 *     near-black marks (Notion, GitHub, Apple, Markdown) `currentColor` is the
 *     better theme-aware default; `brand` is available but will render ~black.
 *
 * The seven brand silhouettes are the canonical single-path marks (24×24
 * viewBox, à la simple-icons); terminal / file / database are hand-drawn
 * outline glyphs in the same viewBox so the whole set stays visually coherent.
 *
 * Storybook-ready: every logo is an isolated, prop-driven component with sane
 * defaults; iterate `LOGO_NAMES` to render the full set.
 */
import type * as React from 'react'

// ── public types ────────────────────────────────────────────────────────────
export type LogoName =
  | 'notion'
  | 'sqlite'
  | 'react'
  | 'typescript'
  | 'markdown'
  | 'github'
  | 'terminal'
  | 'macos'
  | 'file'
  | 'database'

export interface LogoProps {
  /** Square edge length in px. Default 16 — sized for a window-title tag. */
  readonly size?: number
  /**
   * Accessible label. Defaults to the mark's display name (e.g. "Notion"), so
   * the mark is announced by default. Pass `decorative` to opt out instead.
   */
  readonly title?: string
  /** Render as decorative (`aria-hidden`, no label) — for icons beside text. */
  readonly decorative?: boolean
  /** Paint the official brand color instead of `currentColor`. */
  readonly brand?: boolean
  readonly className?: string
  readonly style?: React.CSSProperties
}

/** Official brand colors, for `brand` mode. Marks without a brand color stay `currentColor`. */
export const BRAND_COLOR: Readonly<Record<LogoName, string | null>> = {
  notion: '#000000',
  sqlite: '#003B57',
  react: '#61DAFB',
  typescript: '#3178C6',
  markdown: '#000000',
  github: '#181717',
  macos: '#000000',
  terminal: null,
  file: null,
  database: null,
}

const DISPLAY_NAME: Readonly<Record<LogoName, string>> = {
  notion: 'Notion',
  sqlite: 'SQLite',
  react: 'React',
  typescript: 'TypeScript',
  markdown: 'Markdown',
  github: 'GitHub',
  terminal: 'Terminal',
  macos: 'macOS',
  file: 'File',
  database: 'Database',
}

/** Every logo name — iterate this to render the full set (Storybook / showcases). */
export const LOGO_NAMES = Object.keys(DISPLAY_NAME) as readonly LogoName[]

// ── internals ───────────────────────────────────────────────────────────────
const paint = (name: LogoName, brand: boolean | undefined): string =>
  brand ? (BRAND_COLOR[name] ?? 'currentColor') : 'currentColor'

/**
 * Shared `<svg>` shell: square sizing, 24×24 viewBox, and a11y wiring. `fill`
 * is set on the root so solid single-path marks inherit it; outline glyphs pass
 * `fill="none"` and stroke their children with the resolved color instead.
 */
const Svg = ({
  name,
  size = 16,
  title,
  decorative,
  className,
  style,
  fill,
  children,
}: LogoProps & { name: LogoName; fill: string; children: React.ReactNode }) => {
  const label = title ?? DISPLAY_NAME[name]
  const a11y = decorative
    ? ({ 'aria-hidden': true } as const)
    : ({ role: 'img', 'aria-label': label } as const)
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      focusable="false"
      className={className}
      style={style}
      {...a11y}
    >
      {!decorative && <title>{label}</title>}
      {children}
    </svg>
  )
}

// ── brand marks (canonical single-path silhouettes) ─────────────────────────
export const NotionLogo = (p: LogoProps) => (
  <Svg {...p} name="notion" fill={paint('notion', p.brand)}>
    <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
  </Svg>
)

export const SqliteLogo = (p: LogoProps) => (
  <Svg {...p} name="sqlite" fill={paint('sqlite', p.brand)}>
    <path d="M21.678.521c-1.032-.92-2.28-.55-3.513.544a8.71 8.71 0 0 0-.547.535c-2.109 2.237-4.066 6.38-4.674 9.544.237.48.422 1.093.544 1.561a13.044 13.044 0 0 1 .164.703s-.019-.071-.096-.296l-.05-.146a1.689 1.689 0 0 0-.033-.08c-.138-.32-.518-.995-.686-1.289-.143.423-.27.818-.376 1.176.484.884.778 2.4.778 2.4s-.025-.099-.147-.442c-.107-.303-.644-1.244-.772-1.464-.217.804-.304 1.346-.226 1.478.152.256.296.698.422 1.186.286 1.1.485 2.44.485 2.44l.017.224a22.41 22.41 0 0 0 .056 2.748c.095 1.146.273 2.13.5 2.657l.155-.084c-.334-1.038-.47-2.399-.41-3.967.09-2.398.642-5.29 1.661-8.304 1.723-4.55 4.113-8.201 6.3-9.945-1.993 1.8-4.692 7.63-5.5 9.788-.904 2.416-1.545 4.684-1.931 6.857.666-2.037 2.821-2.912 2.821-2.912s1.057-1.304 2.292-3.166c-.74.169-1.955.458-2.362.629-.6.251-.762.337-.762.337s1.945-1.184 3.613-1.72C21.695 7.9 24.195 2.767 21.678.521m-18.573.543A1.842 1.842 0 0 0 1.27 2.9v16.608a1.84 1.84 0 0 0 1.835 1.834h9.418a22.953 22.953 0 0 1-.052-2.707c-.006-.062-.011-.141-.016-.2a27.01 27.01 0 0 0-.473-2.378c-.121-.47-.275-.898-.369-1.057-.116-.197-.098-.31-.097-.432 0-.12.015-.245.037-.386a9.98 9.98 0 0 1 .234-1.045l.217-.028c-.017-.035-.014-.065-.031-.097l-.041-.381a32.8 32.8 0 0 1 .382-1.194l.2-.019c-.008-.016-.01-.038-.018-.053l-.043-.316c.63-3.28 2.587-7.443 4.8-9.791.066-.069.133-.128.198-.194Z" />
  </Svg>
)

export const ReactLogo = (p: LogoProps) => (
  <Svg {...p} name="react" fill={paint('react', p.brand)}>
    <path d="M14.23 12.004a2.236 2.236 0 0 1-2.235 2.236 2.236 2.236 0 0 1-2.236-2.236 2.236 2.236 0 0 1 2.235-2.236 2.236 2.236 0 0 1 2.236 2.236zm2.648-10.69c-1.346 0-3.107.96-4.888 2.622-1.78-1.653-3.542-2.602-4.887-2.602-.41 0-.783.093-1.106.278-1.375.793-1.683 3.264-.973 6.365C1.98 8.917 0 10.42 0 12.004c0 1.59 1.99 3.097 5.043 4.03-.704 3.113-.39 5.588.988 6.38.32.187.69.275 1.102.275 1.345 0 3.107-.96 4.888-2.624 1.78 1.654 3.542 2.603 4.887 2.603.41 0 .783-.09 1.106-.275 1.374-.792 1.683-3.263.973-6.365C22.02 15.096 24 13.59 24 12.004c0-1.59-1.99-3.097-5.043-4.032.704-3.11.39-5.587-.988-6.38-.318-.184-.688-.277-1.092-.278zm-.005 1.09v.006c.225 0 .406.044.558.127.666.382.955 1.835.73 3.704-.054.46-.142.945-.25 1.44-.96-.236-2.006-.417-3.107-.534-.66-.905-1.345-1.727-2.035-2.447 1.592-1.48 3.087-2.292 4.105-2.295zm-9.77.02c1.012 0 2.514.808 4.11 2.28-.686.72-1.37 1.537-2.02 2.442-1.107.117-2.154.298-3.113.538-.112-.49-.195-.964-.254-1.42-.23-1.868.054-3.32.714-3.707.19-.09.4-.127.563-.132zm4.882 3.05c.455.468.91.992 1.36 1.564-.44-.02-.89-.034-1.345-.034-.46 0-.915.01-1.36.034.44-.572.895-1.096 1.345-1.565zM12 8.1c.74 0 1.477.034 2.202.093.406.582.802 1.203 1.183 1.86.372.64.71 1.29 1.018 1.946-.308.655-.646 1.31-1.013 1.95-.38.66-.773 1.288-1.18 1.87-.728.063-1.466.098-2.21.098-.74 0-1.477-.035-2.202-.093-.406-.582-.802-1.204-1.183-1.86-.372-.64-.71-1.29-1.018-1.946.303-.657.646-1.313 1.013-1.954.38-.66.773-1.286 1.18-1.868.728-.064 1.466-.098 2.21-.098zm-3.635.254c-.24.377-.48.763-.704 1.16-.225.39-.435.782-.635 1.174-.265-.656-.49-1.31-.676-1.947.64-.15 1.315-.283 2.015-.386zm7.26 0c.695.103 1.365.23 2.006.387-.18.632-.405 1.282-.66 1.933-.2-.39-.41-.783-.64-1.174-.225-.392-.465-.774-.705-1.146zm3.063.675c.484.15.944.317 1.375.498 1.732.74 2.852 1.708 2.852 2.476-.005.768-1.125 1.74-2.857 2.475-.42.18-.88.342-1.355.493-.28-.958-.646-1.956-1.1-2.98.45-1.017.81-2.01 1.085-2.964zm-13.395.004c.278.96.645 1.957 1.1 2.98-.45 1.017-.812 2.01-1.086 2.964-.484-.15-.944-.318-1.37-.5-1.732-.737-2.852-1.706-2.852-2.474 0-.768 1.12-1.742 2.852-2.476.42-.18.88-.342 1.356-.494zm11.678 4.28c.265.657.49 1.312.676 1.948-.64.157-1.316.29-2.016.39.24-.375.48-.762.705-1.158.225-.39.435-.788.636-1.18zm-9.945.02c.2.392.41.783.64 1.175.23.39.465.772.705 1.143-.695-.102-1.365-.23-2.006-.386.18-.63.406-1.282.66-1.933zM17.92 16.32c.112.493.2.968.254 1.423.23 1.868-.054 3.32-.714 3.708-.147.09-.338.128-.563.128-1.012 0-2.514-.807-4.11-2.28.686-.72 1.37-1.536 2.02-2.44 1.107-.118 2.154-.3 3.113-.54zm-11.83.01c.96.234 2.006.415 3.107.532.66.905 1.345 1.727 2.035 2.446-1.595 1.483-3.092 2.295-4.11 2.295-.22-.005-.406-.05-.553-.132-.666-.38-.955-1.834-.73-3.703.054-.46.142-.944.25-1.438zm4.56.64c.44.02.89.034 1.345.034.46 0 .915-.01 1.36-.034-.44.572-.895 1.095-1.345 1.565-.455-.47-.91-.993-1.36-1.565z" />
  </Svg>
)

export const TypeScriptLogo = (p: LogoProps) => (
  <Svg {...p} name="typescript" fill={paint('typescript', p.brand)}>
    <path d="M1.125 0C.502 0 0 .502 0 1.125v21.75C0 23.498.502 24 1.125 24h21.75c.623 0 1.125-.502 1.125-1.125V1.125C24 .502 23.498 0 22.875 0zm17.363 9.75c.612 0 1.154.037 1.627.111a6.38 6.38 0 0 1 1.306.34v2.458a3.95 3.95 0 0 0-.643-.361 5.093 5.093 0 0 0-.717-.26 5.453 5.453 0 0 0-1.426-.2c-.3 0-.573.028-.819.086a2.1 2.1 0 0 0-.623.242c-.17.104-.3.229-.393.374a.888.888 0 0 0-.14.49c0 .196.053.373.156.529.104.156.252.304.443.444s.423.276.696.41c.273.135.582.274.926.416.47.197.892.407 1.266.628.374.222.695.473.963.753.268.279.472.598.614.957.142.359.214.776.214 1.253 0 .657-.125 1.21-.373 1.656a3.033 3.033 0 0 1-1.012 1.085 4.38 4.38 0 0 1-1.487.596c-.566.12-1.163.18-1.79.18a9.916 9.916 0 0 1-1.84-.164 5.544 5.544 0 0 1-1.512-.493v-2.63a5.033 5.033 0 0 0 3.237 1.2c.333 0 .624-.03.872-.09.249-.06.456-.144.623-.25.166-.108.29-.234.373-.38a1.023 1.023 0 0 0-.074-1.089 2.12 2.12 0 0 0-.537-.5 5.597 5.597 0 0 0-.807-.444 27.72 27.72 0 0 0-1.007-.436c-.918-.383-1.602-.852-2.053-1.405-.45-.553-.676-1.222-.676-2.005 0-.614.123-1.141.369-1.582.246-.441.58-.804 1.004-1.089a4.494 4.494 0 0 1 1.47-.629 7.536 7.536 0 0 1 1.77-.201zm-15.113.188h9.563v2.166H9.506v9.646H6.789v-9.646H3.375z" />
  </Svg>
)

export const MarkdownLogo = (p: LogoProps) => (
  <Svg {...p} name="markdown" fill={paint('markdown', p.brand)}>
    <path d="M22.27 19.385H1.73A1.73 1.73 0 010 17.655V6.345a1.73 1.73 0 011.73-1.73h20.54A1.73 1.73 0 0124 6.345v11.308a1.73 1.73 0 01-1.73 1.731zM5.769 15.923v-4.5l2.308 2.885 2.307-2.885v4.5h2.308V8.078h-2.308l-2.307 2.885-2.308-2.885H3.46v7.847zM21.232 12h-2.309V8.077h-2.307V12h-2.308l3.461 4.039z" />
  </Svg>
)

export const GitHubLogo = (p: LogoProps) => (
  <Svg {...p} name="github" fill={paint('github', p.brand)}>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </Svg>
)

export const MacOsLogo = (p: LogoProps) => (
  <Svg {...p} name="macos" fill={paint('macos', p.brand)}>
    <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
  </Svg>
)

// ── hand-drawn outline glyphs (coherent with the brand marks' 24×24 viewBox) ─
export const TerminalLogo = (p: LogoProps) => {
  const c = paint('terminal', p.brand)
  return (
    <Svg {...p} name="terminal" fill="none">
      <rect x="2.25" y="4.25" width="19.5" height="15.5" rx="2.4" stroke={c} strokeWidth="1.7" />
      <path
        d="M6 9.2 L9.4 12 L6 14.8"
        stroke={c}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M11.6 14.9 H16.6" stroke={c} strokeWidth="1.7" strokeLinecap="round" />
    </Svg>
  )
}

export const FileLogo = (p: LogoProps) => {
  const c = paint('file', p.brand)
  return (
    <Svg {...p} name="file" fill="none">
      <path
        d="M13.5 2.5 H6.75 A1.75 1.75 0 0 0 5 4.25 V19.75 A1.75 1.75 0 0 0 6.75 21.5 H17.25 A1.75 1.75 0 0 0 19 19.75 V8 Z"
        stroke={c}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M13.5 2.5 V8 H19" stroke={c} strokeWidth="1.6" strokeLinejoin="round" />
      <path
        d="M8.25 12.25 H15.75 M8.25 15.25 H15.75 M8.25 18.25 H13"
        stroke={c}
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Svg>
  )
}

export const DatabaseLogo = (p: LogoProps) => {
  const c = paint('database', p.brand)
  return (
    <Svg {...p} name="database" fill="none">
      <ellipse cx="12" cy="5.6" rx="7" ry="2.85" stroke={c} strokeWidth="1.7" />
      <path
        d="M5 5.6 V18.4 C5 19.97 8.13 21.25 12 21.25 S19 19.97 19 18.4 V5.6"
        stroke={c}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M5 12 C5 13.57 8.13 14.85 12 14.85 S19 13.57 19 12"
        stroke={c}
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </Svg>
  )
}

// ── dispatcher ──────────────────────────────────────────────────────────────
const REGISTRY: Readonly<Record<LogoName, (p: LogoProps) => React.JSX.Element>> = {
  notion: NotionLogo,
  sqlite: SqliteLogo,
  react: ReactLogo,
  typescript: TypeScriptLogo,
  markdown: MarkdownLogo,
  github: GitHubLogo,
  terminal: TerminalLogo,
  macos: MacOsLogo,
  file: FileLogo,
  database: DatabaseLogo,
}

/** Name-dispatched logo. `<TechLogo name="notion" size={16} />`. */
export const TechLogo = ({ name, ...rest }: LogoProps & { name: LogoName }) => {
  const Logo = REGISTRY[name]
  return <Logo {...rest} />
}
