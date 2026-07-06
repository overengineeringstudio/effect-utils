/**
 * Generator phase (R31, decision 0004).
 *
 * Each generator has a phase that is declared by a STATIC source pragma so it is discoverable
 * WITHOUT importing the generator — importing a `design-time` generator would itself require the
 * runtime graph (e.g. `effect`), which is exactly what is unavailable before install.
 *
 * - `bootstrap` — the generator's output an install step depends on, so it must run before
 *   package-manager install and its transitive runtime closure must stay bootstrap-safe (R06).
 *   Declared with a `// @genie-phase bootstrap` line in the `.genie.ts` source.
 * - `design-time` — the DEFAULT (unmarked). Runs after install and may depend on the runtime graph
 *   (e.g. the Effect-Schema semconv/weaver generators).
 *
 * The pragma is deliberately a plain line comment, matched against the raw source text: no import,
 * no TypeScript parse, no dependency on install state. This is the one static ground truth for
 * phase; completeness of the bootstrap set is arbitrated by install ordering, not by this file.
 */

/** The phase a generator runs in: `bootstrap` (before install, must be bootstrap-safe) or `design-time` (after install). */
export type GeneratorPhase = 'bootstrap' | 'design-time'

/** All generator phases, in declaration order — the choice set for the `genie --phase` CLI option. */
export const GENERATOR_PHASES = ['bootstrap', 'design-time'] as const

/** Phase assumed for a generator that carries no `// @genie-phase` pragma. */
export const DEFAULT_GENERATOR_PHASE: GeneratorPhase = 'design-time'

/**
 * Matches a `// @genie-phase <phase>` line comment (leading whitespace allowed). Conventionally the
 * first line of a `.genie.ts` source, but accepted anywhere in the file.
 */
const PHASE_PRAGMA_RE = /^[ \t]*\/\/[ \t]*@genie-phase[ \t]+(bootstrap|design-time)\b/m

/** Parse the declared phase from a `.genie.ts` source text. Absent pragma ⇒ {@link DEFAULT_GENERATOR_PHASE}. */
export const parseGeneratorPhase = (sourceText: string): GeneratorPhase => {
  const match = PHASE_PRAGMA_RE.exec(sourceText)
  return match?.[1] === 'bootstrap' ? 'bootstrap' : DEFAULT_GENERATOR_PHASE
}
