/**
 * Composition.stories — the connectors + morph primitives that glue two surfaces
 * together: `Flow` (one-way sync rail), `DirFlow` (push / pull / two-way), `Swap`
 * (was→now crossfade) and the causal role bands on `NotionBlock` / `CodeLine`.
 *
 * REFACTOR NOTE: `Flow`/`DirFlow` animate their rail + badge via a
 * `.seq[data-mode="anim"][data-step="N"]` ancestor; `Swap` picks WHICH step it
 * flips from the surrounding pane selector (`.dbb-grid .swap` vs `.ntn-tbl .swap`).
 * Rendered standalone (as here) they show a correct STATIC resting state but do not
 * animate — the animated form lives in the Sequence story.
 */
import type { Meta, StoryObj } from '@storybook/react'
import { CodeLine, DirFlow, Flow, KW, NotionBlock, STR, Swap } from './components.tsx'
import type { FlowDirection } from './syncStory.ts'

const meta = {
  title: 'Kit/Composition',
  parameters: { layout: 'centered' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

/** The one-way sync rail (SQLite → Notion). Static resting state outside a Sequence. */
export const FlowRail: Story = {
  name: 'Flow',
  render: () => (
    <div style={{ width: 140 }}>
      <Flow done="synced" idle="db sync" syncing="syncing…" />
    </div>
  ),
}

/** The directional connector — every variant (push → / ← pull / ⇄ two-way). */
export const DirFlowVariants: Story = {
  name: 'DirFlow (push / pull / two)',
  render: () => {
    const variants: readonly { direction: FlowDirection; badge: string; note: string }[] = [
      { direction: 'push', badge: 'push', note: '.nmd → Notion' },
      { direction: 'pull', badge: 'pull', note: 'Notion → .nmd' },
      { direction: 'two', badge: 'merge', note: 'both ways' },
    ]
    return (
      <div style={{ display: 'flex', gap: 40 }}>
        {variants.map((v) => (
          <div key={v.direction} style={{ width: 140 }}>
            <DirFlow direction={v.direction} badge={v.badge} note={v.note} />
          </div>
        ))}
      </div>
    )
  },
}

/** The was→now crossfade. Both layers stack; a live Sequence crossfades between
 *  them at the gated step. Here both are visible so you can see the endpoints. */
export const SwapMorph: Story = {
  name: 'Swap (was → now)',
  render: () => (
    <div className="dbb-grid" style={{ display: 'flex', gap: 32, alignItems: 'center' }}>
      <Swap was="$25" now="$30" />
      <Swap was="In Progress" now="Done" />
    </div>
  ),
}

/** NotionBlock causal role bands: `orig` (authored/blue) vs `recv` (received/green)
 *  vs plain. The band color comes from the kit CSS role classes. */
export const NotionBlockRoles: Story = {
  name: 'NotionBlock roles',
  render: () => (
    <div className="ntn-page" style={{ maxWidth: 320 }}>
      <NotionBlock>Plain block (no role)</NotionBlock>
      <NotionBlock role="orig">Authored here — the cause (orig)</NotionBlock>
      <NotionBlock role="recv">Received on sync — the effect (recv)</NotionBlock>
    </div>
  ),
}

/** CodeLine causal role bands inside an `.ide-code` gutter. */
export const CodeLineRoles: Story = {
  name: 'CodeLine roles',
  render: () => (
    <div className="ide-code" style={{ maxWidth: 360 }}>
      <CodeLine>
        <KW>const</KW> price = <STR>'$25'</STR>
      </CodeLine>
      <CodeLine role="orig">
        <KW>const</KW> price = <STR>'$30'</STR> <span className="cm">// edited</span>
      </CodeLine>
      <CodeLine role="recv">
        <span className="cm">// ✓ received from Notion</span>
      </CodeLine>
    </div>
  ),
}
