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

export const You: Actor = { name: 'You', color: '#5b5bd6' }
export const Teammate: Actor = { name: 'Robin', color: '#0f9d8a' }
