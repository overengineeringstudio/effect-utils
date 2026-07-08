/**
 * actors.ts — collaborator personas for the <TypingCaret> primitive.
 *
 * An actor is a name + an identity hue. The hue is theme-INDEPENDENT
 * (drives `--actor-color`, over which the caret/flag renders white text),
 * so the same value is legible in light and dark. Two-way "stories" (md's
 * shared beat) render two actors; single-author stories (sqlite) use `You`.
 */
export interface Actor {
  readonly name: string
  /** identity hue — theme-independent, white text sits on top */
  readonly color: string
}

/**
 * You = BLUE, Teammate = ACCENT/purple. This mirrors the notion-md role-band
 * semantics (spec §3.3): a locally-authored edit reads blue, a Notion/teammate
 * edit reads accent/purple. Cross-port note: the sqlite pilot renders `You`'s
 * caret, so its caret hue shifts purple→blue with this change (a .next rebuild,
 * not a live-file edit) — blue-for-"You" is the intended, more-correct mapping.
 */
export const You: Actor = { name: 'You', color: '#2f6fd6' }
export const Teammate: Actor = { name: 'Robin', color: '#5b5bd6' }
