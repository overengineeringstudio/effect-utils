/** The declaration kind; a schedule is a mission carrying native timing. */
export type SubjectKind = 'agent' | 'mission' | 'schedule'

/** An imported source module identity, resolved against the subject tree at publication. */
export interface SubjectRef<K extends SubjectKind> {
  readonly _tag: 'SubjectRef'
  readonly kind: K
  readonly url: string
}

/** A source-owned seat identity; serializes to agent/<path-derived-id>. */
export type AgentRef = SubjectRef<'agent'>
/** A source-owned mission identity; pin explicitly when moving heads are inappropriate. */
export type MissionRef = SubjectRef<'mission'>

/** The source-owned declaration, including its identity and immutable intent factory. */
export interface SubjectDefinition<K extends SubjectKind, I, C> extends SubjectRef<K> {
  readonly intent: I | ((context: C) => I)
}
