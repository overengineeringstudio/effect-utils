import { describe, expect, it } from 'vitest'

import type { Offer, Pending } from '@overeng/scg-protocol'

import {
  type Button,
  type CardIds,
  type CardResult,
  type Component,
  type DiscordMessage,
  codeSpan,
  escapeDiscord,
  formatAbsolute,
  formatClock,
  layoutOffers,
  MessageFlags,
  originWordsMode,
  renderClosedCard,
  renderInspectReply,
  renderPendingCard,
  renderWordsReply,
  validateMessage,
} from './card.ts'

// Synthetic data only: example commands/accounts, fixed timestamps, fake digests.
const env = { timeZone: 'Europe/Berlin' }
const at = (hour: number, minute: number) => Date.UTC(2026, 10, 17, hour, minute)
const digestOf = (char: string) => `sha256:${char.repeat(64)}`
const guardrail = { total: 20, calls: 6, windowSeconds: 60 } as const

type Review = Pending['review']
type Origin = NonNullable<Review['context']>['origin']
type OfferOf<TKind extends Offer['kind']> = Extract<Offer, { readonly kind: TKind }>
const review: Review = {
  command: 'mail.search',
  account: 'example-account',
  sensitivity: 'low',
  fields: [
    { label: 'query', value: 'from:billing@example.com invoice' },
    { label: 'max', value: '20' },
  ],
  agentClaim: 'Find the synthetic invoice for the example ledger.',
}

const once: OfferOf<'allow-once'> = {
  optionId: 'opt-once',
  kind: 'allow-once',
  statement: 'Allow once · mail.search on example-account',
}
const deny: OfferOf<'deny'> = {
  optionId: 'opt-deny',
  kind: 'deny',
  statement: 'Deny · nothing runs',
}
const similar1h: OfferOf<'similar-lease'> = {
  optionId: 'opt-1h',
  kind: 'similar-lease',
  statement: 'Allow + similar until 15:00',
  command: 'mail.search',
  account: 'example-account',
  selector: { folder: 'inbox' },
  duration: '1h',
  until: at(14, 0),
  guardrail,
}
const similar4h: OfferOf<'similar-lease'> = {
  ...similar1h,
  optionId: 'opt-4h',
  statement: 'Allow + similar until 18:00',
  duration: '4h',
  until: at(17, 0),
}
const toParent: OfferOf<'grant-to-parent'> = {
  optionId: 'opt-parent',
  kind: 'grant-to-parent',
  statement: 'Grant parent P1 until 18:00',
  parentSession: 'P1',
  command: 'mail.search',
  account: 'example-account',
  selector: {},
  until: at(17, 0),
  guardrail,
}
const sessionRule: OfferOf<'session-rule'> = {
  optionId: 'opt-rule',
  kind: 'session-rule',
  statement: 'Rule: up to 5 creates until 18:00',
  session: 'S1',
  rules: [
    {
      operation: 'write',
      command: 'calendar.create',
      account: 'example-account',
      where: { calendar: 'example-cal' },
      mandatorySelectors: ['calendar'],
      maxCalls: 5,
      rate: { calls: 2, windowSeconds: 60 },
      until: at(17, 0),
    },
  ],
}
const manifest: OfferOf<'manifest-approve'> = {
  optionId: 'opt-manifest',
  kind: 'manifest-approve',
  statement: 'Allow these 2 once',
  items: [
    {
      executionId: '00000000-0000-4000-8000-000000000011',
      actionDigest: digestOf('1'),
      review: { ...review, tier: 'read' },
    },
    {
      executionId: '00000000-0000-4000-8000-000000000012',
      actionDigest: digestOf('2'),
      review: {
        ...review,
        command: 'mail.send',
        tier: 'write',
        sensitivity: 'sensitive',
        fields: [{ label: 'to', value: 'secret-recipient' }],
      },
    },
  ],
}

const basePending: Pending = {
  epoch: 'scg-experiment-v1',
  kind: 'pending',
  executionId: '00000000-0000-4000-8000-000000000001',
  requestDigest: digestOf('a'),
  actionDigest: digestOf('b'),
  review,
  options: [once, deny],
  issuedAt: at(13, 0),
  expiresAt: at(13, 30),
}

const ids: CardIds = {
  options: {
    'opt-once': 'c:opaque-1',
    'opt-deny': 'c:opaque-2',
    'opt-1h': 'c:opaque-5',
    'opt-4h': 'c:opaque-6',
    'opt-parent': 'c:opaque-7',
    'opt-rule': 'c:opaque-8',
    'opt-manifest': 'c:opaque-9',
  },
  inspect: 'c:opaque-3',
  words: 'c:opaque-4',
}
const idsWithoutWords: CardIds = { options: ids.options, inspect: ids.inspect }

const withReview = (
  overrides: Partial<Review>,
  options: readonly Offer[] = basePending.options,
): Pending => ({
  ...basePending,
  review: { ...review, ...overrides },
  options,
})

const origin = (overrides: Partial<Origin> = {}): Origin => ({
  locator: 'origin:synthetic-1',
  digest: digestOf('c'),
  provenance: 'fractal-recorded',
  surface: 'discord',
  at: at(12, 2),
  place: 'DM with Assistant',
  wordsAvailable: true,
  ...overrides,
})

const withOrigin = (
  originOverrides: Partial<Origin> = {},
  overrides: Partial<Review> = {},
): Pending =>
  withReview({
    ...overrides,
    context: {
      origin: origin(originOverrides),
      chain: ['Mission M1', 'step two', 'session S1', 'subagent A1'],
      audit: [],
      flags: [],
    },
  })

const words = {
  digest: digestOf('c'),
  text: 'please reconcile the synthetic invoices against the example ledger',
}

const ok = (result: CardResult): DiscordMessage => {
  if (result._tag !== 'Ok') throw new Error(`expected Ok, got ${result.errors.join('; ')}`)
  return result.message
}

const flatten = (components: readonly Component[]): Component[] =>
  components.flatMap((component) => [
    component,
    ...('components' in component ? flatten(component.components) : []),
    ...('accessory' in component ? [component.accessory] : []),
  ])
const buttonsOf = (message: DiscordMessage) =>
  flatten(message.components).filter((component): component is Button => component.type === 2)
const labelsOf = (message: DiscordMessage) => buttonsOf(message).map((button) => button.label)
const textOf = (message: DiscordMessage) =>
  flatten(message.components)
    .flatMap((component) => (component.type === 10 ? [component.content] : []))
    .join('\n')

describe('pending card', () => {
  it('renders a V2 rich container whose buttons are the signed statements with opaque ids', () => {
    const message = ok(renderPendingCard(basePending, ids, env))
    expect(message.flags).toBe(MessageFlags.IsComponentsV2)
    expect(message.allowed_mentions).toEqual({ parse: [] })
    expect(message.components).toHaveLength(1)
    expect(message.components[0]?.type).toBe(17)
    expect(
      buttonsOf(message).map((button) => [button.label, button.custom_id, button.style]),
    ).toEqual([
      ['Inspect', 'c:opaque-3', 2],
      ['Allow once · mail.search on example-account', 'c:opaque-1', 3],
      ['Deny · nothing runs', 'c:opaque-2', 4],
    ])
    const text = textOf(message)
    expect(text).toContain('### Approval request · exact call')
    expect(text).toContain('Decide by **14:30 (UTC+01:00)** · <t:1794922200:R>')
    expect(text).toContain('`mail.search` on `example-account`')
    expect(text).toContain('**query** `from:billing@example.com invoice`')
    expect(text).toContain('*Agent says (unverified):*')
    expect(text).not.toContain('Allow \\+ similar')
  })

  it('orders allow offers before deny regardless of offer order', () => {
    expect(layoutOffers([deny, similar1h, once, sessionRule]).decisions).toEqual([once, deny])
  })

  it('names the tier in the header and uses the write accent', () => {
    const message = ok(renderPendingCard(withReview({ tier: 'write' }), ids, env))
    expect(textOf(message)).toContain('### Write request')
    expect(message.components[0]).toMatchObject({ type: 17, accent_color: 0xf0b232 })
  })

  it('renders D33 session, holds and coverage lines', () => {
    const message = ok(
      renderPendingCard(
        withReview({
          session: { label: 'S1', verified: true },
          holds: [{ label: 'mail.search', used: 3, cap: 20 }],
          coverage: { kind: 'would-create', text: 'exact call only' },
        }),
        ids,
        env,
      ),
    )
    const text = textOf(message)
    expect(text).toContain('Session `S1` · ✓ verified')
    expect(text).toContain('**Holds** mail\\.search 3/20')
    expect(text).toContain('**Would create** exact call only')
  })

  it('renders the similar row only when offered, with absolute end and bounds above it', () => {
    const message = ok(
      renderPendingCard(withReview({}, [once, deny, similar1h, similar4h]), ids, env),
    )
    expect(labelsOf(message)).toEqual([
      'Inspect',
      'Allow once · mail.search on example-account',
      'Deny · nothing runs',
      'Allow + similar until 15:00',
      'Allow + similar until 18:00',
    ])
    const text = textOf(message)
    expect(text).toContain('**Allow + similar**')
    expect(text).toContain('`mail.search` on `example-account` · where folder = `inbox`')
    expect(text).toContain('until Tue 17 Nov 2026 15:00 (UTC+01:00)')
    expect(text).toContain('until Tue 17 Nov 2026 18:00 (UTC+01:00)')
    expect(text).toContain('≤20 calls total · ≤6 per 60 s')
  })

  it('renders grant-to-parent naming the parent and its delegation consequence', () => {
    const message = ok(renderPendingCard(withReview({}, [once, deny, toParent]), ids, env))
    expect(labelsOf(message)).toContain('Grant parent P1 until 18:00')
    const text = textOf(message)
    expect(text).toContain('**Grant to parent**')
    expect(text).toContain('parent `P1`; its children may receive delegated subsets')
    expect(text).toContain('where any target')
  })

  it('shows session rules read-only and never as a signing control', () => {
    const message = ok(renderPendingCard(withReview({}, [sessionRule, deny]), ids, env))
    expect(labelsOf(message)).toEqual(['Inspect', 'Deny · nothing runs'])
    expect(buttonsOf(message).map((button) => button.custom_id)).not.toContain('c:opaque-8')
    const text = textOf(message)
    expect(text).toContain('read-only here; sign on iOS/macOS, or Deny to reject')
    expect(text).toContain(
      'write `calendar.create` on `example-account` · where calendar = `example-cal` · required `calendar`',
    )
    expect(text).toContain('max 5 · ≤2 per 60 s · until Tue 17 Nov 2026 18:00 (UTC+01:00)')
  })

  it('renders manifest items and hides sensitive item contents', () => {
    const message = ok(renderPendingCard(withReview({}, [manifest, deny]), ids, env))
    expect(labelsOf(message)).toContain('Allow these 2 once')
    const text = textOf(message)
    expect(text).toContain('**2 calls in this manifest**')
    expect(text).toContain('1. `mail.search` on `example-account`')
    expect(text).toContain('2. ✏️ write · `mail.send` on `example-account`')
    expect(text).toContain('🔒 contents hidden · Inspect')
    expect(text).not.toContain('secret-recipient')
  })

  it('hides everything beyond command and account for sensitive requests, withholding lease offers visibly', () => {
    const pending = withOrigin(
      {},
      {
        sensitivity: 'sensitive',
        tier: 'read',
        session: { label: 'S-secret', verified: true },
        holds: [{ label: 'secret-hold', used: 1, cap: 2 }],
        coverage: { kind: 'covered-by', text: 'secret-coverage' },
      },
    )
    const message = ok(
      renderPendingCard(
        { ...pending, options: [once, deny, similar1h, toParent, sessionRule] },
        ids,
        env,
        words,
      ),
    )
    const serialized = JSON.stringify(message)
    for (const hidden of [
      'billing@example.com',
      'synthetic invoice',
      'S-secret',
      'secret-hold',
      'secret-coverage',
      'DM with Assistant',
      'reconcile',
      'Mission M1',
      'Read request',
      'inbox',
      'example-cal',
    ])
      expect(serialized).not.toContain(hidden)
    const text = textOf(message)
    expect(text).toContain('`mail.search` on `example-account`')
    expect(text).toContain('2 wider grant offer(s) not signable here')
    expect(labelsOf(message)).toEqual([
      'Inspect',
      'Show my words',
      'Allow once · mail.search on example-account',
      'Deny · nothing runs',
    ])
  })

  it('escapes untrusted text so it cannot mention or format', () => {
    const message = ok(
      renderPendingCard(withReview({ agentClaim: '@everyone <@123> **bold**' }), ids, env),
    )
    expect(textOf(message)).toContain('\\@everyone \\<\\@123\\> \\*\\*bold\\*\\*')
  })

  it('rejects a missing custom id instead of rendering an unmapped control', () => {
    const result = renderPendingCard(
      basePending,
      { ...ids, options: { 'opt-deny': 'c:opaque-2' } },
      env,
    )
    expect(result).toEqual({ _tag: 'Rejected', errors: ['missing custom_id for option opt-once'] })
  })

  it('rejects duplicate custom ids', () => {
    expect(renderPendingCard(basePending, { ...ids, inspect: 'c:opaque-1' }, env)._tag).toBe(
      'Rejected',
    )
  })

  it('fails oversized payloads rather than truncating', () => {
    const result = renderPendingCard(
      withReview({ fields: [{ label: 'body', value: 'x'.repeat(4001) }] }),
      ids,
      env,
    )
    expect(result._tag).toBe('Rejected')
    if (result._tag === 'Rejected') expect(result.errors.join()).toContain('> 4000')
  })

  it('fails when a signed statement does not fit a button label', () => {
    const result = renderPendingCard(
      withReview({}, [{ ...once, statement: `Allow once · ${'c'.repeat(80)}` }, deny]),
      ids,
      env,
    )
    expect(result._tag).toBe('Rejected')
    if (result._tag === 'Rejected') expect(result.errors.join()).toContain('label length')
  })
})

describe('origin context (D37/D38)', () => {
  it('quotes Discord-born words with provenance and chain', () => {
    const pending = withOrigin()
    expect(originWordsMode(pending.review)).toBe('quote')
    const message = ok(renderPendingCard(pending, ids, env, words))
    const text = textOf(message)
    expect(text).toContain('You asked · 13:02 (UTC+01:00) · <t:')
    expect(text).toContain('· Discord · DM with Assistant')
    expect(text).toContain('> please reconcile the synthetic invoices against the example ledger')
    expect(text).toContain('◆ recorded by Fractal · not device-signed')
    expect(text).toContain('↳ Mission M1 › step two › session S1 › subagent A1')
    expect(labelsOf(message)).not.toContain('Show my words')
  })

  it('cuts long Discord quotes visibly and offers the full words ephemerally', () => {
    const message = ok(
      renderPendingCard(withOrigin(), ids, env, { ...words, text: 'w'.repeat(200) }),
    )
    expect(textOf(message)).toContain(`> ${'w'.repeat(160)} …`)
    expect(labelsOf(message)).toContain('Show my words')
  })

  it('never quotes off-Discord words; shows a handle and Show my words', () => {
    const pending = withOrigin({ surface: 'other', place: 'terminal session', turn: 'turn 6' })
    expect(originWordsMode(pending.review)).toBe('handle')
    const message = ok(renderPendingCard(pending, ids, env, words))
    const text = textOf(message)
    expect(text).not.toContain('reconcile')
    expect(text).toContain('terminal session · turn 6')
    expect(text).toContain('your words stay off this card')
    expect(labelsOf(message)).toContain('Show my words')
  })

  it('renders claimed origins as "No linked ask" and never quotes them', () => {
    const pending = withOrigin({ provenance: 'claimed' })
    expect(originWordsMode(pending.review)).toBe('claimed')
    const message = ok(renderPendingCard(pending, ids, env, words))
    expect(textOf(message)).toContain('**No linked ask**')
    expect(JSON.stringify(message)).not.toContain('reconcile')
    expect(labelsOf(message)).not.toContain('Show my words')
    expect(renderWordsReply(pending, words, env)._tag).toBe('Rejected')
  })

  it('degrades to the handle when words are not hydrated', () => {
    expect(textOf(ok(renderPendingCard(withOrigin(), ids, env)))).toContain('words unavailable')
  })

  it('rejects words whose digest does not match the origin', () => {
    const result = renderPendingCard(withOrigin(), ids, env, { ...words, digest: digestOf('d') })
    expect(result).toEqual({ _tag: 'Rejected', errors: ['origin words digest mismatch'] })
  })

  it('requires a words custom id when Show my words is offered', () => {
    const result = renderPendingCard(withOrigin({ surface: 'other' }), idsWithoutWords, env)
    expect(result).toEqual({ _tag: 'Rejected', errors: ['missing custom_id for Show my words'] })
  })

  it('caps "Since your ask" at 3 rows and flags at 3', () => {
    const pending = withReview({
      context: {
        origin: origin(),
        chain: [],
        audit: [1, 2, 3, 4, 5].map((n) => ({ at: at(12, 10 + n), text: `audit row ${n}` })),
        flags: ['new-account', 'first-write', 'outside-delegation', 'asked-before'],
      },
    })
    const text = textOf(ok(renderPendingCard(pending, ids, env, words)))
    expect(text).toContain('**Since your ask** · SCG record · 2 earlier in Inspect')
    expect(text).not.toContain('audit row 2')
    for (const n of [3, 4, 5]) expect(text).toContain(`audit row ${n}`)
    expect(text).toContain('⚑ New account · First write · Outside delegation')
    expect(text).not.toContain('Asked before')
    const inspect = textOf(ok(renderInspectReply(pending, env)))
    for (const n of [1, 2, 3, 4, 5]) expect(inspect).toContain(`audit row ${n}`)
  })
})

describe('closed card', () => {
  const cases = [
    [
      { _tag: 'Resolved', state: 'succeeded', decidedElsewhere: false, optionId: 'opt-4h' },
      '✅ **Allowed** · ran.\n-# signed: Allow \\+ similar until 18\\:00',
    ],
    [
      { _tag: 'Resolved', state: 'denied', decidedElsewhere: true, at: at(13, 10) },
      '✖️ **Denied** on another surface · 14:10 (UTC+01:00) · nothing ran.',
    ],
    [
      { _tag: 'Resolved', state: 'expired', decidedElsewhere: false },
      '⌛ **Expired** · no decision; nothing ran.',
    ],
    [
      { _tag: 'Withdrawn' },
      '**Withdrawn** · this card no longer decides anything; nothing runs from it.',
    ],
  ] as const

  for (const [closure, line] of cases) {
    it(`removes every control (${closure._tag}${'state' in closure ? ` ${closure.state}` : ''})`, () => {
      const pending = {
        ...withOrigin({ surface: 'other' }),
        options: [once, deny, similar1h, similar4h, toParent],
      }
      const result = renderClosedCard(pending, closure, env)
      const message = ok(result)
      expect(buttonsOf(message)).toEqual([])
      expect(result._tag === 'Ok' && result.stats.buttons).toBe(0)
      expect(textOf(message)).toContain(line)
    })
  }

  it('keeps sensitive contents hidden on the closed card', () => {
    const message = ok(
      renderClosedCard(withReview({ sensitivity: 'sensitive' }), { _tag: 'Withdrawn' }, env),
    )
    expect(JSON.stringify(message)).not.toContain('billing@example.com')
  })
})

describe('ephemeral replies', () => {
  it('Inspect shows exact sensitive contents and every offer only to the approver', () => {
    const pending = withReview({ sensitivity: 'sensitive' }, [
      once,
      deny,
      similar1h,
      toParent,
      sessionRule,
      manifest,
    ])
    const message = ok(renderInspectReply(pending, env))
    expect(message.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral)
    expect(buttonsOf(message)).toEqual([])
    const text = textOf(message)
    expect(text).toContain('`from:billing@example.com invoice`')
    expect(text).toContain('*Agent says (unverified):*')
    expect(text).toContain('where folder = `inbox`')
    expect(text).toContain('parent `P1`')
    expect(text).toContain('`example-cal`')
    expect(text).toContain('`secret-recipient`')
    expect(text).toContain(`\`${digestOf('a')}\``)
    expect(text).toContain('decide by Tue 17 Nov 2026 14:30 (UTC+01:00)')
  })

  it('Show my words returns the full verified words ephemerally', () => {
    const message = ok(
      renderWordsReply(withOrigin({ surface: 'other' }, { sensitivity: 'sensitive' }), words, env),
    )
    expect(message.flags).toBe(MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral)
    expect(textOf(message)).toContain(`> ${words.text}`)
  })

  it('Show my words rejects mismatched digests and wordless origins', () => {
    expect(renderWordsReply(withOrigin(), { ...words, digest: digestOf('e') }, env)._tag).toBe(
      'Rejected',
    )
    expect(renderWordsReply(withOrigin({ wordsAvailable: false }), words, env)._tag).toBe(
      'Rejected',
    )
    expect(renderWordsReply(basePending, words, env)._tag).toBe('Rejected')
  })
})

describe('validateMessage', () => {
  const text = (content: string) => ({ type: 10, content }) as const
  const button = (customId: string, label = 'Go') =>
    ({ type: 2, style: 2, label, custom_id: customId }) as const
  const body = (components: DiscordMessage['components']): DiscordMessage => ({
    flags: MessageFlags.IsComponentsV2,
    allowed_mentions: { parse: [] },
    components,
  })

  it('accepts a top-level text display for an inert publication placeholder', () => {
    const result = validateMessage(
      body([text('Authenticating review. No decision is available yet.')]),
    )
    expect(result.ok).toBe(true)
    expect(result.stats.components).toBe(1)
    expect(result.stats.buttons).toBe(0)
  })

  it('counts nested components and rejects more than 40', () => {
    const result = validateMessage(
      body([
        { type: 17, accent_color: 0, components: Array.from({ length: 40 }, () => text('x')) },
      ]),
    )
    expect(result.stats.components).toBe(41)
    expect(result.errors).toContain('total components 41 > 40')
  })

  it('rejects more than 5 buttons per row', () => {
    const row = { type: 1, components: [1, 2, 3, 4, 5, 6].map((n) => button(`b${n}`)) } as const
    expect(validateMessage(body([{ type: 17, accent_color: 0, components: [row] }])).ok).toBe(false)
  })

  it('rejects long labels, long and duplicate custom ids', () => {
    const row = {
      type: 1,
      components: [button('x'.repeat(101)), button('dup', 'l'.repeat(81)), button('dup')],
    } as const
    const { errors } = validateMessage(body([{ type: 17, accent_color: 0, components: [row] }]))
    expect(errors.some((error) => error.includes('custom_id length 101'))).toBe(true)
    expect(errors.some((error) => error.includes('label length 81'))).toBe(true)
    expect(errors.some((error) => error.includes('duplicate custom_id'))).toBe(true)
  })

  it('rejects unescaped mentions but accepts escaped ones, code spans and timestamps', () => {
    expect(
      validateMessage(body([{ type: 17, accent_color: 0, components: [text('hi @everyone')] }])).ok,
    ).toBe(false)
    expect(
      validateMessage(body([{ type: 17, accent_color: 0, components: [text('hi <@&42>')] }])).ok,
    ).toBe(false)
    expect(
      validateMessage(
        body([
          {
            type: 17,
            accent_color: 0,
            components: [text(`hi \\@everyone ${codeSpan('<@42>')} <t:1:R>`)],
          },
        ]),
      ).ok,
    ).toBe(true)
  })

  it('rejects sections without 1–3 text displays and a missing V2 flag', () => {
    const section = {
      type: 9,
      components: [text('a'), text('b'), text('c'), text('d')],
      accessory: button('s'),
    } as const
    const { errors } = validateMessage({
      ...body([{ type: 17, accent_color: 0, components: [section] }]),
      flags: 0,
    })
    expect(errors).toContain('IS_COMPONENTS_V2 flag missing')
    expect(errors.some((error) => error.includes('section has 4 text displays'))).toBe(true)
  })
})

describe('literal text and time', () => {
  it('escapes markdown and makes deceptive code points visible', () => {
    expect(escapeDiscord('a*b\u202Ec\nd')).toBe('a\\*b\\\\u\\{202E\\}c\\\\nd')
    expect(codeSpan('a`b')).toBe('`a\\u{0060}b`')
  })

  it('formats absolute times with a numeric offset', () => {
    expect(formatClock(at(13, 30), 'Europe/Berlin')).toBe('14:30 (UTC+01:00)')
    expect(formatAbsolute(at(17, 0), 'Europe/Berlin')).toBe('Tue 17 Nov 2026 18:00 (UTC+01:00)')
    expect(formatClock(at(13, 30), 'UTC')).toBe('13:30 (UTC+00:00)')
  })
})
