/**
 * Generator phase (R31, decision 0004).
 *
 * Each generator has a phase that is declared by a STATIC source pragma so it is discoverable
 * WITHOUT importing the generator — importing a `design-time` generator would itself require the
 * runtime graph (e.g. `effect`), which is exactly what is unavailable before install.
 *
 * - `bootstrap` — the generator's output an install step depends on, so it must run before
 *   package-manager install and its transitive runtime closure must stay bootstrap-safe (R06).
 *   Declared with a `// @genie-bootstrap` flag comment in the `.genie.ts` source — a valueless,
 *   namespace-prefixed pragma mirroring TypeScript grammar (`@ts-nocheck`/`@ts-check`).
 * - `design-time` — the DEFAULT (no marker). Runs after install and may depend on the runtime graph
 *   (e.g. the Effect-Schema semconv/weaver generators).
 *
 * The pragma is deliberately a plain line comment, matched against the raw source text: no import,
 * no TypeScript parse, no dependency on install state. This is the one static ground truth for
 * phase. Completeness of the bootstrap set is demonstrated empirically by the cold-proof (R32,
 * `bootstrap:cold-proof`), not arbitrated by this file or by install ordering.
 */

/** The phase a generator runs in: `bootstrap` (before install, must be bootstrap-safe) or `design-time` (after install). */
export type GeneratorPhase = 'bootstrap' | 'design-time'

/** All generator phases, in declaration order — the choice set for the `genie --phase` CLI option. */
export const GENERATOR_PHASES = ['bootstrap', 'design-time'] as const

/** Phase assumed for a generator that carries no `// @genie-bootstrap` marker. */
export const DEFAULT_GENERATOR_PHASE: GeneratorPhase = 'design-time'

/**
 * Matches a `// @genie-bootstrap` flag comment (leading whitespace allowed, valueless). Conventionally
 * placed in the leading comment block of a `.genie.ts` source, but accepted anywhere in the file. The
 * trailing `(?![\w-])` lookahead keeps a longer namespaced flag like `@genie-bootstrap-later` from
 * matching; the leading line-comment anchor keeps the flag from matching when the token appears
 * inside a string literal or a block comment rather than a real line comment.
 */
const BOOTSTRAP_PRAGMA_RE = /^[ \t]*\/\/[ \t]*@genie-bootstrap(?![\w-])/m

/**
 * Parse the declared phase from a `.genie.ts` source text. A `// @genie-bootstrap` flag yields
 * `bootstrap`; its absence yields {@link DEFAULT_GENERATOR_PHASE} (`design-time`).
 */
export const parseGeneratorPhase = (sourceText: string): GeneratorPhase =>
  BOOTSTRAP_PRAGMA_RE.test(sourceText) === true ? 'bootstrap' : DEFAULT_GENERATOR_PHASE
