/**
 * SCG Discord approval card (Components V2, "B · Rich container").
 *
 * Pure renderers from the shared C7 `Pending` record to Discord API v10 message
 * bodies. Every rendered message is checked by `validateMessage` against the
 * documented Discord limits; a payload that does not fit is rejected, never
 * truncated, because the card must show exactly what each button signs.
 *
 * Anatomy (D33 + D37 + D38), in order:
 *   header      kind · decide by                      (only line safe for push previews)
 *   origin      You asked · time · place · turn       (D37; words quoted only when D38 allows)
 *               provenance · chain mission › … › subagent
 *   title       command on account
 *   session     verified session line
 *   fields      exact fields, then "Agent says (unverified)"
 *   offers      manifest items · session rules (read-only, never signable here)
 *   authority   Holds · Covered by / Would create · Since your ask (≤3) · flags (≤3)
 *   decide      allow / manifest / deny row; each button label = the signed offer statement
 *   similar     only when offered: scope, absolute end and bounds, then its buttons
 *   parent      only when offered (D39): parent named, then its buttons
 *   footer      execution id · digest · time zone
 *
 * Sensitive reviews show nothing beyond command + account on the shared card (lease
 * offers withheld with a visible note); everything else is behind the ephemeral
 * Inspect / Show my words replies.
 *
 * Custom IDs are opaque: the handler mints them, stores the mapping to the pending
 * digest and option ID durably, and passes them in via `CardIds`. The handler must
 * resolve the signed option from that mapping, never from a button label.
 */
import type { Offer, Pending, State } from '@overeng/scg-protocol'

// ── Public types ──

/** Review section of a pending record, as rendered on the card. */
export type Review = Pending['review']
/** Terminal state a closed card reports. */
export type ClosedState = Exclude<typeof State.Type, 'pending'>
type Context = NonNullable<Review['context']>
type Origin = Context['origin']

/** Opaque custom IDs minted and durably mapped by the interaction handler. */
export interface CardIds {
  /**
   * Custom ID per signed offer, keyed by `Offer.optionId`. Required for every offer the
   * card turns into a button (session rules and, on sensitive cards, lease offers get none).
   */
  readonly options: Readonly<Record<string, string>>
  /** Ephemeral "Inspect" control (signs nothing). */
  readonly inspect: string
  /** Ephemeral "Show my words" control (signs nothing); required when the origin's words are available and not quoted in full. */
  readonly words?: string
}

/** Rendering environment shared by every card renderer. */
export interface CardEnv {
  /** IANA zone for absolute times; always rendered with a numeric UTC offset. */
  readonly timeZone: string
}

/**
 * Origin words hydrated at render time by the handler's origin resolver. The signer
 * has already checked protocol `digest(text) === review.context.origin.digest`; the
 * renderer re-checks the carried digest so words cannot attach to another origin.
 * Transient: never stored (D38).
 */
export interface VerifiedOriginWords {
  readonly digest: string
  readonly text: string
}

/** Why a card closed. `optionId` names the signed offer; `decidedElsewhere` that another surface signed. */
export type CardClosure =
  | {
      readonly _tag: 'Resolved'
      readonly state: ClosedState
      readonly decidedElsewhere: boolean
      readonly optionId?: string
      readonly at?: number
    }
  | { readonly _tag: 'Withdrawn'; readonly at?: number }

/** Components V2 text display (type 10). */
export interface TextDisplay {
  readonly type: 10
  readonly content: string
}
/** Components V2 separator (type 14). */
export interface Separator {
  readonly type: 14
  readonly divider: boolean
  readonly spacing: 1 | 2
}
/** Components V2 button (type 2); always carries an opaque custom ID. */
export interface Button {
  readonly type: 2
  readonly style: 1 | 2 | 3 | 4
  readonly label: string
  readonly custom_id: string
}
/** Components V2 action row (type 1) of up to five buttons. */
export interface ActionRow {
  readonly type: 1
  readonly components: readonly Button[]
}
/** Components V2 section (type 9): 1–3 text displays with a button accessory. */
export interface Section {
  readonly type: 9
  readonly components: readonly TextDisplay[]
  readonly accessory: Button
}
/** Any component a container may hold. */
export type ContainerChild = TextDisplay | Separator | ActionRow | Section
/** Components V2 container (type 17) with an accent color. */
export interface Container {
  readonly type: 17
  readonly accent_color: number
  readonly components: readonly ContainerChild[]
}
/** Any component `validateMessage` visits. */
export type Component = Container | ContainerChild | Button

/** Message body for POST/PATCH channel messages or interaction response `data`. */
export interface DiscordMessage {
  readonly flags: number
  readonly allowed_mentions: { readonly parse: readonly [] }
  readonly components: readonly (Container | TextDisplay)[]
}

/** Counts `validateMessage` measured on a message body. */
export interface MessageStats {
  readonly components: number
  readonly textChars: number
  readonly buttons: number
}

/** Rendered message with its stats, or the reasons it was rejected (never truncated). */
export type CardResult =
  | { readonly _tag: 'Ok'; readonly message: DiscordMessage; readonly stats: MessageStats }
  | { readonly _tag: 'Rejected'; readonly errors: readonly string[] }

/** Discord message flags the card renderers set. */
export const MessageFlags = {
  Ephemeral: 1 << 6,
  IsComponentsV2: 1 << 15,
} as const

/** Documented Discord Components V2 limits and the card's own display caps. */
export const Limits = {
  totalComponents: 40,
  textChars: 4000,
  buttonsPerRow: 5,
  buttonLabel: 80,
  customId: 100,
  sectionTexts: 3,
  /** D37: "Since your ask" rows and derived flags shown on the card. */
  contextRows: 3,
  /** D38: Discord-born words quoted on the card; the full text stays behind Show my words. */
  quoteChars: 160,
} as const

// ── Escaping (literal-text rule) ──

const DECEPTIVE_CODE_POINTS = /(?! )[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Zs}]/gu
const visibleCodePoint = (char: string) =>
  `\\u{${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`
const visibleControl = (char: string) =>
  char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : visibleCodePoint(char)

/** Untrusted value as literal Discord markdown: deceptive code points visible, ASCII punctuation escaped. */
export const escapeDiscord = (value: string): string =>
  value
    .replace(DECEPTIVE_CODE_POINTS, visibleControl)
    .replace(/[!-/:-@[-`{-~]/g, (char) => `\\${char}`)

/**
 * Untrusted value inside an inline code span. Markdown is inert inside code, so the
 * only breakout (backtick) and deceptive code points become visible `\u{XXXX}` text.
 */
export const codeSpan = (value: string): string =>
  `\`${value.replace(DECEPTIVE_CODE_POINTS, visibleControl).replace(/`/g, visibleCodePoint)}\``

// ── Time ──

const timeParts = ({ at, timeZone }: { readonly at: number; readonly timeZone: string }) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(new Date(at))
      .map((part) => [part.type, part.value]),
  )

/** `GMT+01:00` → `UTC+01:00`; bare `GMT` → `UTC+00:00` so the offset is always numeric. */
const offsetLabel = (zoneName: string | undefined) => {
  const raw = (zoneName ?? 'GMT').replace('GMT', 'UTC')
  return raw === 'UTC' ? 'UTC+00:00' : raw
}

/** `14:30 (UTC+01:00)` */
export const formatClock = ({
  at,
  timeZone,
}: {
  readonly at: number
  readonly timeZone: string
}): string => {
  const p = timeParts({ at, timeZone })
  return `${p.hour}:${p.minute} (${offsetLabel(p.timeZoneName)})`
}

/** `Tue 17 Nov 2026 18:00 (UTC+01:00)`: full absolute time for deadlines and bounds. */
export const formatAbsolute = ({
  at,
  timeZone,
}: {
  readonly at: number
  readonly timeZone: string
}): string => {
  const p = timeParts({ at, timeZone })
  return `${p.weekday} ${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute} (${offsetLabel(p.timeZoneName)})`
}

/** Client-rendered live relative time (`in 30 minutes`); always next to an absolute time. */
const relative = (ms: number) => `<t:${Math.floor(ms / 1000)}:R>`

// ── Builders ──

const Accent = {
  read: 0x5865f2,
  write: 0xf0b232,
  allowed: 0x23a55a,
  denied: 0xda373c,
  neutral: 0x80848e,
} as const

const ButtonStyle = { primary: 1, secondary: 2, success: 3, danger: 4 } as const

const text = (content: string): TextDisplay => ({ type: 10, content })
const row = (...components: Button[]): ActionRow => ({ type: 1, components })
const button = ({
  style,
  label,
  customId,
}: {
  readonly style: Button['style']
  readonly label: string
  readonly customId: string
}): Button => ({
  type: 2,
  style,
  label,
  custom_id: customId,
})
const container = ({
  accent,
  components,
}: {
  readonly accent: number
  readonly components: readonly ContainerChild[]
}): Container => ({
  type: 17,
  accent_color: accent,
  components,
})
const message = ({
  components,
  extraFlags = 0,
}: {
  readonly components: readonly Container[]
  readonly extraFlags?: number
}): DiscordMessage => ({
  flags: MessageFlags.IsComponentsV2 | extraFlags,
  allowed_mentions: { parse: [] },
  components,
})

// ── Offers: every control is one signed offer, labelled with its statement ──

type OfferOf<TKind extends Offer['kind']> = Extract<Offer, { readonly kind: TKind }>

/** Offers grouped by where the card may show them (D33). */
export interface OfferLayout {
  /** Primary row: allow-once / manifest-approve first, deny last. */
  readonly decisions: readonly Offer[]
  /** Secondary row: similar leases, each with absolute end + bounds shown above. */
  readonly similar: readonly OfferOf<'similar-lease'>[]
  /** D39 grant-to-parent offers, shown with the parent named. */
  readonly parent: readonly OfferOf<'grant-to-parent'>[]
  /** Session rules: read-only on Discord (sign on iOS/macOS, reject via deny). */
  readonly rules: readonly OfferOf<'session-rule'>[]
}

/** Groups offers into decision, similar-lease, grant-to-parent and session-rule slots (D33). */
export const layoutOffers = (options: readonly Offer[]): OfferLayout => {
  const allow: Offer[] = []
  const deny: Offer[] = []
  const similar: OfferOf<'similar-lease'>[] = []
  const parent: OfferOf<'grant-to-parent'>[] = []
  const rules: OfferOf<'session-rule'>[] = []
  for (const offer of options) {
    switch (offer.kind) {
      case 'allow-once':
      case 'manifest-approve':
        allow.push(offer)
        break
      case 'deny':
        deny.push(offer)
        break
      case 'similar-lease':
        similar.push(offer)
        break
      case 'grant-to-parent':
        parent.push(offer)
        break
      case 'session-rule':
        rules.push(offer)
        break
    }
  }
  return { decisions: [...allow, ...deny], similar, parent, rules }
}

const offerStyle = (offer: Offer): Button['style'] =>
  offer.kind === 'deny'
    ? ButtonStyle.danger
    : offer.kind === 'allow-once' || offer.kind === 'manifest-approve'
      ? ButtonStyle.success
      : ButtonStyle.secondary

/** Button label = the signed statement verbatim (plain text; deceptive code points visible). */
export const offerLabel = (offer: Offer): string =>
  offer.statement.replace(DECEPTIVE_CODE_POINTS, visibleControl)

const selectorText = (selector: OfferOf<'similar-lease'>['selector']) => {
  const entries = Object.entries(selector)
  if (entries.length === 0) return 'any target'
  return entries
    .map(
      ([key, value]) =>
        `${escapeDiscord(key)} = ${typeof value === 'string' ? codeSpan(value) : value.map(codeSpan).join(', ')}`,
    )
    .join(' · ')
}

const guardrailText = (guardrail: OfferOf<'similar-lease'>['guardrail']) =>
  `≤${guardrail.total} calls total · ≤${guardrail.calls} per ${guardrail.windowSeconds} s`

/** Full scope, absolute end and bounds of a lease-like offer; the button repeats only the statement. */
const leaseLine = ({
  offer,
  env,
}: {
  readonly offer: OfferOf<'similar-lease'> | OfferOf<'grant-to-parent'>
  readonly env: CardEnv
}) =>
  [
    `**${escapeDiscord(offer.statement)}**`,
    `-# ${codeSpan(offer.command)} on ${codeSpan(offer.account)} · where ${selectorText(offer.selector)}`,
    `-# until ${formatAbsolute({ at: offer.until, timeZone: env.timeZone })} · ${relative(offer.until)} · ${guardrailText(offer.guardrail)}`,
  ].join('\n')

const parentText = ({
  offers,
  env,
}: {
  readonly offers: readonly OfferOf<'grant-to-parent'>[]
  readonly env: CardEnv
}) =>
  [
    `**Grant to parent** · sibling sessions wait on the same command and account`,
    ...offers.map(
      (offer) =>
        `${leaseLine({ offer, env })}\n-# parent ${codeSpan(offer.parentSession)}; its children may receive delegated subsets`,
    ),
  ].join('\n')

const rulesText = ({
  offers,
  env,
}: {
  readonly offers: readonly OfferOf<'session-rule'>[]
  readonly env: CardEnv
}) =>
  [
    '**Session rule** · read-only here; sign on iOS/macOS, or Deny to reject',
    ...offers.flatMap((offer) => [
      `${escapeDiscord(offer.statement)} · session ${codeSpan(offer.session)}`,
      ...offer.rules.map(
        (rule) =>
          `-# ${rule.operation} ${codeSpan(rule.command)} on ${codeSpan(rule.account)} · where ${selectorText(rule.where)}` +
          `${rule.mandatorySelectors.length > 0 ? ` · required ${rule.mandatorySelectors.map(codeSpan).join(', ')}` : ''}` +
          ` · max ${rule.maxCalls} · ≤${rule.rate.calls} per ${rule.rate.windowSeconds} s · until ${formatAbsolute({ at: rule.until, timeZone: env.timeZone })}`,
      ),
    ]),
  ].join('\n')

/**
 * Manifest items: command + account always. `fields`: `none` on sensitive cards,
 * `public` hides sensitive items' contents, `all` (ephemeral Inspect) shows everything.
 */
const manifestText = ({
  offer,
  fields,
}: {
  readonly offer: OfferOf<'manifest-approve'>
  readonly fields: 'none' | 'public' | 'all'
}) =>
  [
    `**${offer.items.length} calls in this manifest** · run in order, nothing can be appended`,
    ...offer.items.map((item, index) => {
      const head = `${index + 1}. ${item.review.tier === 'write' ? '✏️ write · ' : ''}${titleLine(item.review)}`
      if (fields === 'none') return head
      if (fields === 'public' && item.review.sensitivity === 'sensitive')
        return `${head}\n-# 🔒 contents hidden · Inspect`
      const lines = item.review.fields.map(
        (field) => `-# ${escapeDiscord(field.label)} ${codeSpan(field.value)}`,
      )
      return [head, ...lines].join('\n')
    }),
  ].join('\n')

const chunk = <TItem>({
  items,
  size,
}: {
  readonly items: readonly TItem[]
  readonly size: number
}): TItem[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  )

// ── Origin rules (D37/D38) ──

/** Where a request's origin words may appear (D37/D38). */
export type OriginWordsMode =
  /** No origin context on the request. */
  | 'none'
  /** Claimed origin: "No linked ask", never quoted or offered. */
  | 'claimed'
  /** Words unavailable (hydration failed or not recorded). */
  | 'unavailable'
  /** Discord-born, non-sensitive: quoted on the shared card. */
  | 'quote'
  /** Off-Discord or sensitive: handle only on the card; words via ephemeral Show my words. */
  | 'handle'

/** Where a request's origin words may appear. Sensitive requests never quote publicly. */
export const originWordsMode = (review: Review): OriginWordsMode => {
  const origin = review.context?.origin
  if (origin === undefined) return 'none'
  if (origin.provenance === 'claimed') return 'claimed'
  if (origin.wordsAvailable === false) return 'unavailable'
  return origin.surface === 'discord' && review.sensitivity !== 'sensitive' ? 'quote' : 'handle'
}

const provenanceLabel: Record<Origin['provenance'], string> = {
  'device-signed': '✓ your message · device-signed',
  'fractal-recorded': '◆ recorded by Fractal · not device-signed',
  claimed: '⚠ agent-claimed link · unverified',
}

const flagLabel: Record<Context['flags'][number], string> = {
  'new-account': 'New account',
  'first-write': 'First write',
  'outside-delegation': 'Outside delegation',
  'asked-before': 'Asked before',
}

const originMeta = ({ origin, env }: { readonly origin: Origin; readonly env: CardEnv }) =>
  [
    'You asked',
    formatClock({ at: origin.at, timeZone: env.timeZone }),
    relative(origin.at),
    origin.surface === 'discord' ? 'Discord' : undefined,
    origin.place.length > 0 ? escapeDiscord(origin.place) : undefined,
    origin.turn === undefined ? undefined : escapeDiscord(origin.turn),
  ]
    .filter((part) => part !== undefined)
    .join(' · ')

/** Quote block for words; `>` prefixed per line, every line escaped. */
const quoteBlock = (words: string) =>
  words
    .split('\n')
    .map((line) => `> ${escapeDiscord(line)}`)
    .join('\n')

// ── Card sections ──

interface Controls {
  readonly inspect: Button
  readonly words: Button | undefined
}

const headerLine = ({ pending, env }: { readonly pending: Pending; readonly env: CardEnv }) => {
  const kind =
    pending.review.sensitivity === 'sensitive' || pending.review.tier === undefined
      ? 'Approval request'
      : pending.review.tier === 'write'
        ? 'Write request'
        : 'Read request'
  return `### ${kind} · exact call\nDecide by **${formatClock({ at: pending.expiresAt, timeZone: env.timeZone })}** · ${relative(pending.expiresAt)}`
}

const titleLine = (review: Review) => `${codeSpan(review.command)} on ${codeSpan(review.account)}`

const fieldsText = (review: Review) =>
  review.fields
    .map((field) => `**${escapeDiscord(field.label)}** ${codeSpan(field.value)}`)
    .join('\n')

const claimText = (claim: string) => `> *Agent says (unverified):* ${escapeDiscord(claim)}`

const sessionLine = (session: NonNullable<Review['session']>) =>
  `Session ${codeSpan(session.label)} · ${session.verified === true ? '✓ verified' : '⚠ unverified'}`

/** D33 compact authority line(s) + D37 "Since your ask"; all derived from the SCG record. */
const authorityText = ({
  review,
  env,
  cap,
}: {
  readonly review: Review
  readonly env: CardEnv
  readonly cap: number
}) => {
  const lines: string[] = []
  if (review.holds !== undefined && review.holds.length > 0)
    lines.push(
      `**Holds** ${review.holds.map((hold) => `${escapeDiscord(hold.label)} ${hold.used}/${hold.cap}`).join(' · ')}`,
    )
  if (review.coverage !== undefined)
    lines.push(
      `**${review.coverage.kind === 'covered-by' ? 'Covered by' : 'Would create'}** ${escapeDiscord(review.coverage.text)}`,
    )
  const context = review.context
  if (context !== undefined && context.audit.length > 0) {
    const shown = context.audit.slice(-cap)
    const more = context.audit.length - shown.length
    lines.push(
      `**Since your ask** · SCG record${more > 0 ? ` · ${more} earlier in Inspect` : ''}`,
      ...shown.map(
        (entry) =>
          `-# ${formatClock({ at: entry.at, timeZone: env.timeZone })} · ${escapeDiscord(entry.text)}`,
      ),
    )
  }
  if (context !== undefined && context.flags.length > 0)
    lines.push(
      `⚑ ${context.flags
        .slice(0, cap)
        .map((flag) => flagLabel[flag])
        .join(' · ')}`,
    )
  return lines.length === 0 ? undefined : lines.join('\n')
}

/**
 * D37 origin block for the shared card. Claimed origins render "No linked ask" with
 * no quote and no words control; off-Discord words only as a handle + Show my words.
 */
const originComponents = ({
  review,
  env,
  words,
  wordsButton,
  errors,
}: {
  readonly review: Review
  readonly env: CardEnv
  readonly words: VerifiedOriginWords | undefined
  readonly wordsButton: Button | undefined
  readonly errors: string[]
}): ContainerChild[] => {
  const context = review.context
  if (context === undefined) return []
  const origin = context.origin
  const chain =
    context.chain.length > 0 ? `↳ ${context.chain.map(escapeDiscord).join(' › ')}` : undefined
  const mode = originWordsMode(review)
  if (mode === 'claimed') {
    return [
      text(
        ['**No linked ask**', `-# ${provenanceLabel.claimed}`, chain]
          .filter((l) => l !== undefined)
          .join('\n'),
      ),
    ]
  }
  const lines: string[] = [originMeta({ origin, env })]
  if (mode === 'quote' && words !== undefined) {
    if (words.digest !== origin.digest) errors.push('origin words digest mismatch')
    const quoted =
      words.text.length > Limits.quoteChars
        ? `${words.text.slice(0, Limits.quoteChars)} …`
        : words.text
    lines.push(quoteBlock(quoted))
  } else if (mode === 'quote' || mode === 'unavailable') {
    // Hydration failed or nothing recorded: degrade to the handle, decision still possible.
    lines.push('-# words unavailable')
  } else {
    lines.push('-# your words stay off this card')
  }
  lines.push(`-# ${provenanceLabel[origin.provenance]}`)
  if (chain !== undefined) lines.push(chain)
  const truncated = mode === 'quote' && words !== undefined && words.text.length > Limits.quoteChars
  const offerWords = mode === 'handle' || truncated
  if (offerWords === true && wordsButton !== undefined)
    return [{ type: 9, components: [text(lines.join('\n'))], accessory: wordsButton }]
  return [text(lines.join('\n'))]
}

/**
 * Shared card body; `controls` undefined renders the terminal (control-free) variant.
 * Manifest items and session rules are part of what is being decided, so they render
 * here; lease offers render next to their buttons in `renderPendingCard`.
 */
const cardBody = ({
  pending,
  layout,
  env,
  controls,
  words,
  errors,
}: {
  readonly pending: Pending
  readonly layout: OfferLayout
  readonly env: CardEnv
  readonly controls: Controls | undefined
  readonly words: VerifiedOriginWords | undefined
  readonly errors: string[]
}): ContainerChild[] => {
  const review = pending.review
  const manifests = layout.decisions.flatMap((offer) =>
    offer.kind === 'manifest-approve' ? [offer] : [],
  )
  if (review.sensitivity === 'sensitive') {
    const children: ContainerChild[] = [text(titleLine(review))]
    for (const offer of manifests) children.push(text(manifestText({ offer, fields: 'none' })))
    children.push(text('🔒 Contents hidden · sensitive request. Inspect shows them only to you.'))
    if (layout.rules.length > 0)
      children.push(
        text('-# Session rule offered · read-only; review in Inspect, sign on iOS/macOS.'),
      )
    if (controls !== undefined)
      children.push(
        controls.words === undefined
          ? row(controls.inspect)
          : row(controls.inspect, controls.words),
      )
    return children
  }
  const children: ContainerChild[] = [
    ...originComponents({ review, env, words, wordsButton: controls?.words, errors }),
    text(titleLine(review)),
  ]
  if (review.session !== undefined) children.push(text(sessionLine(review.session)))
  const details: string[] = []
  if (review.fields.length > 0) details.push(fieldsText(review))
  if (review.agentClaim.trim().length > 0) details.push(claimText(review.agentClaim))
  if (details.length > 0) {
    const detailsText = text(details.join('\n'))
    children.push(
      controls === undefined
        ? detailsText
        : { type: 9, components: [detailsText], accessory: controls.inspect },
    )
  } else if (controls !== undefined) {
    children.push({ type: 9, components: [text('-# No fields.')], accessory: controls.inspect })
  }
  for (const offer of manifests) children.push(text(manifestText({ offer, fields: 'public' })))
  if (layout.rules.length > 0) children.push(text(rulesText({ offers: layout.rules, env })))
  const authority = authorityText({ review, env, cap: Limits.contextRows })
  if (authority !== undefined) children.push(text(authority))
  return children
}

const footerLine = ({ pending, env }: { readonly pending: Pending; readonly env: CardEnv }) =>
  `-# ${escapeDiscord(pending.executionId)} · digest ${pending.requestDigest.replace(/^sha256:/, '').slice(0, 12)} · times ${escapeDiscord(env.timeZone)}`

const tierAccent = (review: Review) => (review.tier === 'write' ? Accent.write : Accent.read)

// ── Renderers ──

/**
 * Waiting card. Every button is one signed offer labelled with its statement:
 * primary row = allow / manifest / deny; a secondary "Allow + similar" row and a
 * grant-to-parent row only when offered, each preceded by its scope, absolute end and
 * bounds. Session rules never get a signing control (D33). On sensitive cards lease
 * offers are withheld (their bounds cannot be shown publicly) with a visible note.
 * Discord-born words must be passed (digest-verified) to be quoted.
 */
export const renderPendingCard = ({
  pending,
  ids,
  env,
  originWords,
}: {
  readonly pending: Pending
  readonly ids: CardIds
  readonly env: CardEnv
  /** Digest-verified origin words; required for Discord-born words to be quoted. */
  readonly originWords?: VerifiedOriginWords | undefined
}): CardResult => {
  const errors: string[] = []
  const layout = layoutOffers(pending.options)
  const sensitive = pending.review.sensitivity === 'sensitive'
  const toButton = (offer: Offer): Button[] => {
    const customId = ids.options[offer.optionId]
    if (customId !== undefined)
      return [button({ style: offerStyle(offer), label: offerLabel(offer), customId })]
    errors.push(`missing custom_id for option ${offer.optionId}`)
    return []
  }
  const decisions = layout.decisions.flatMap(toButton)
  const similar = sensitive === true ? [] : layout.similar.flatMap(toButton)
  const parent = sensitive === true ? [] : layout.parent.flatMap(toButton)

  const mode = originWordsMode(pending.review)
  const wordsOffered =
    mode === 'handle' || (mode === 'quote' && (originWords?.text.length ?? 0) > Limits.quoteChars)
  if (wordsOffered === true && ids.words === undefined)
    errors.push('missing custom_id for Show my words')
  const controls: Controls = {
    inspect: button({ style: ButtonStyle.secondary, label: 'Inspect', customId: ids.inspect }),
    words:
      wordsOffered === true && ids.words !== undefined
        ? button({ style: ButtonStyle.secondary, label: 'Show my words', customId: ids.words })
        : undefined,
  }
  const body = cardBody({ pending, layout, env, controls, words: originWords, errors })
  if (errors.length > 0) return { _tag: 'Rejected', errors }

  const children: ContainerChild[] = [text(headerLine({ pending, env })), ...body]
  if (decisions.length > 0)
    children.push(
      { type: 14, divider: true, spacing: 1 },
      ...chunk({ items: decisions, size: Limits.buttonsPerRow }).map((buttons) => row(...buttons)),
    )
  if (similar.length > 0)
    children.push(
      { type: 14, divider: true, spacing: 2 },
      text(
        ['**Allow + similar**', ...layout.similar.map((offer) => leaseLine({ offer, env }))].join(
          '\n',
        ),
      ),
      ...chunk({ items: similar, size: Limits.buttonsPerRow }).map((buttons) => row(...buttons)),
    )
  if (parent.length > 0)
    children.push(
      { type: 14, divider: true, spacing: 2 },
      text(parentText({ offers: layout.parent, env })),
      ...chunk({ items: parent, size: Limits.buttonsPerRow }).map((buttons) => row(...buttons)),
    )
  const withheld = sensitive === true ? layout.similar.length + layout.parent.length : 0
  if (withheld > 0)
    children.push(
      text(
        `-# ${withheld} wider grant offer(s) not signable here: sensitive request. Review in Inspect; sign on iOS/macOS.`,
      ),
    )
  children.push(text(footerLine({ pending, env })))
  return finish(
    message({
      components: [container({ accent: tierAccent(pending.review), components: children })],
    }),
  )
}

const closureCopy = ({
  pending,
  closure,
  env,
}: {
  readonly pending: Pending
  readonly closure: CardClosure
  readonly env: CardEnv
}): { accent: number; line: string } => {
  const when =
    closure.at === undefined ? '' : ` · ${formatClock({ at: closure.at, timeZone: env.timeZone })}`
  if (closure._tag === 'Withdrawn')
    return {
      accent: Accent.neutral,
      line: `**Withdrawn**${when} · this card no longer decides anything; nothing runs from it.`,
    }
  const where = closure.decidedElsewhere === true ? ' on another surface' : ''
  const offer = pending.options.find((option) => option.optionId === closure.optionId)
  const signed = offer === undefined ? '' : `\n-# signed: ${escapeDiscord(offer.statement)}`
  switch (closure.state) {
    case 'reserved':
      return { accent: Accent.allowed, line: `✅ **Allowed**${where}${when} · running.${signed}` }
    case 'succeeded':
      return { accent: Accent.allowed, line: `✅ **Allowed**${where}${when} · ran.${signed}` }
    case 'failed':
      return {
        accent: Accent.denied,
        line: `⚠️ **Allowed**${where}${when} · the run failed.${signed}`,
      }
    case 'denied':
      return { accent: Accent.denied, line: `✖️ **Denied**${where}${when} · nothing ran.${signed}` }
    case 'expired':
      return { accent: Accent.neutral, line: `⌛ **Expired**${when} · no decision; nothing ran.` }
    case 'unknown':
      return { accent: Accent.neutral, line: `❔ **Outcome unknown**${where}${when}.${signed}` }
  }
}

/** Terminal PATCH (decided, decided elsewhere, expired, withdrawn): outcome accent + line, every control removed. */
export const renderClosedCard = ({
  pending,
  closure,
  env,
  originWords,
}: {
  readonly pending: Pending
  readonly closure: CardClosure
  readonly env: CardEnv
  /** Digest-verified origin words; required for Discord-born words to be quoted. */
  readonly originWords?: VerifiedOriginWords | undefined
}): CardResult => {
  const errors: string[] = []
  const { accent, line } = closureCopy({ pending, closure, env })
  const body = cardBody({
    pending,
    layout: layoutOffers(pending.options),
    env,
    controls: undefined,
    words: originWords,
    errors,
  })
  if (errors.length > 0) return { _tag: 'Rejected', errors }
  return finish(
    message({
      components: [
        container({
          accent,
          components: [text(line), ...body, text(footerLine({ pending, env }))],
        }),
      ],
    }),
  )
}

/**
 * Ephemeral Inspect reply: exact fields, claim, session, every offer with full scope
 * and bounds (manifest items with fields, session rules read-only), the full authority
 * trail, origin handle and chain, digests. Signs nothing and never quotes origin words.
 */
export const renderInspectReply = ({
  pending,
  env,
}: {
  readonly pending: Pending
  readonly env: CardEnv
}): CardResult => {
  const review = pending.review
  const layout = layoutOffers(pending.options)
  const children: ContainerChild[] = [
    text(`### Inspect · only visible to you\n${titleLine(review)}`),
  ]
  if (review.session !== undefined) children.push(text(sessionLine(review.session)))
  children.push(text(review.fields.length > 0 ? fieldsText(review) : '-# No fields.'))
  if (review.agentClaim.trim().length > 0) children.push(text(claimText(review.agentClaim)))
  for (const offer of layout.decisions)
    if (offer.kind === 'manifest-approve')
      children.push(text(manifestText({ offer, fields: 'all' })))
  const offerLines = [
    ...layout.decisions.map((offer) => `• ${escapeDiscord(offer.statement)}`),
    ...layout.similar.map((offer) => leaseLine({ offer, env })),
  ]
  children.push(text(['**Offers**', ...offerLines].join('\n')))
  if (layout.parent.length > 0) children.push(text(parentText({ offers: layout.parent, env })))
  if (layout.rules.length > 0) children.push(text(rulesText({ offers: layout.rules, env })))
  const context = review.context
  if (context !== undefined) {
    const origin = context.origin
    const lines =
      origin.provenance === 'claimed'
        ? ['**No linked ask**', `-# ${provenanceLabel.claimed}`]
        : [originMeta({ origin, env }), `-# ${provenanceLabel[origin.provenance]}`]
    if (context.chain.length > 0) lines.push(`↳ ${context.chain.map(escapeDiscord).join(' › ')}`)
    children.push(text(lines.join('\n')))
  }
  const authority = authorityText({ review, env, cap: Number.POSITIVE_INFINITY })
  if (authority !== undefined) children.push(text(authority))
  children.push(
    text(
      [
        `-# request ${codeSpan(pending.requestDigest)}`,
        `-# action ${codeSpan(pending.actionDigest)}`,
        `-# issued ${formatAbsolute({ at: pending.issuedAt, timeZone: env.timeZone })} · decide by ${formatAbsolute({ at: pending.expiresAt, timeZone: env.timeZone })}`,
      ].join('\n'),
    ),
  )
  return finish(
    message({
      components: [container({ accent: tierAccent(review), components: children })],
      extraFlags: MessageFlags.Ephemeral,
    }),
  )
}

/**
 * Ephemeral "Show my words" reply (D38): the full, digest-verified origin words, only
 * to the approver. Claimed or wordless origins are rejected: they are never quoted.
 */
export const renderWordsReply = ({
  pending,
  words,
  env,
}: {
  readonly pending: Pending
  readonly words: VerifiedOriginWords
  readonly env: CardEnv
}): CardResult => {
  const origin = pending.review.context?.origin
  if (origin === undefined) return { _tag: 'Rejected', errors: ['request has no origin'] }
  if (origin.provenance === 'claimed')
    return { _tag: 'Rejected', errors: ['claimed origin words are never quoted'] }
  if (origin.wordsAvailable === false)
    return { _tag: 'Rejected', errors: ['origin words unavailable'] }
  if (words.digest !== origin.digest)
    return { _tag: 'Rejected', errors: ['origin words digest mismatch'] }
  return finish(
    message({
      components: [
        container({
          accent: Accent.neutral,
          components: [
            text(`### Your words · only visible to you\n${originMeta({ origin, env })}`),
            text(quoteBlock(words.text)),
            text(`-# ${provenanceLabel[origin.provenance]}`),
          ],
        }),
      ],
      extraFlags: MessageFlags.Ephemeral,
    }),
  )
}

const finish = (body: DiscordMessage): CardResult => {
  const result = validateMessage(body)
  return result.ok === true
    ? { _tag: 'Ok', message: body, stats: result.stats }
    : { _tag: 'Rejected', errors: result.errors }
}

// ── Validation (subset of the documented Discord limits; covers every emitted component) ──

/** Unescaped user/role/channel mentions or mass pings (timestamps `<t:…>` are fine). */
const MENTION = /(?<!\\)<(?:@[!&]?|#)\d+>|(?<!\\)@(?:everyone|here)\b/

/** Outcome of `validateMessage`: errors (empty when ok) and the measured stats. */
export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly stats: MessageStats
}

/** Checks a message body against Components V2 limits; fails rather than letting Discord truncate or 400. */
export const validateMessage = (body: DiscordMessage): ValidationResult => {
  const errors: string[] = []
  const customIds = new Set<string>()
  let components = 0
  let textChars = 0
  let buttons = 0

  if ((body.flags & MessageFlags.IsComponentsV2) === 0) errors.push('IS_COMPONENTS_V2 flag missing')
  if (body.allowed_mentions.parse.length !== 0) errors.push('allowed_mentions.parse must be []')
  if ('content' in body || 'embeds' in body) errors.push('IS_COMPONENTS_V2 forbids content/embeds')

  const visit = ({
    component,
    path,
  }: {
    readonly component: Component
    readonly path: string
  }): void => {
    components += 1
    switch (component.type) {
      case 17: {
        if (component.accent_color < 0 || component.accent_color > 0xffffff)
          errors.push(`${path} accent_color out of range`)
        component.components.forEach((child, i) =>
          visit({ component: child, path: `${path}.components[${i}]` }),
        )
        return
      }
      case 9: {
        const n = component.components.length
        if (n < 1 || n > Limits.sectionTexts)
          errors.push(`${path} section has ${n} text displays (1–3)`)
        component.components.forEach((child, i) =>
          visit({ component: child, path: `${path}.components[${i}]` }),
        )
        visit({ component: component.accessory, path: `${path}.accessory` })
        return
      }
      case 1: {
        const n = component.components.length
        if (n < 1 || n > Limits.buttonsPerRow)
          errors.push(`${path} action row has ${n} buttons (1–5)`)
        component.components.forEach((child, i) =>
          visit({ component: child, path: `${path}.components[${i}]` }),
        )
        return
      }
      case 2: {
        buttons += 1
        if (component.label.length < 1 || component.label.length > Limits.buttonLabel)
          errors.push(`${path} label length ${component.label.length} (1–80)`)
        if (MENTION.test(component.label) === true) errors.push(`${path} label contains a mention`)
        const id = component.custom_id
        if (id.length < 1 || id.length > Limits.customId)
          errors.push(`${path} custom_id length ${id.length} (1–100)`)
        if (customIds.has(id) === true) errors.push(`${path} duplicate custom_id`)
        customIds.add(id)
        return
      }
      case 10: {
        textChars += component.content.length
        if (component.content.length === 0) errors.push(`${path} empty text display`)
        // Code spans render mentions inert; outside them every untrusted `<`/`@` is escaped.
        if (MENTION.test(component.content.replace(/(?<!\\)`[^`]*`/g, '')) === true)
          errors.push(`${path} text contains a mention`)
        return
      }
      case 14: {
        if (component.spacing !== 1 && component.spacing !== 2)
          errors.push(`${path} separator spacing`)
        return
      }
    }
  }
  body.components.forEach((component, i) => visit({ component, path: `components[${i}]` }))

  if (components > Limits.totalComponents)
    errors.push(`total components ${components} > ${Limits.totalComponents}`)
  if (textChars > Limits.textChars)
    errors.push(`text display chars ${textChars} > ${Limits.textChars}`)
  return { ok: errors.length === 0, errors, stats: { components, textChars, buttons } }
}
