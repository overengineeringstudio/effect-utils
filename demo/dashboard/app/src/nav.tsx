import { DEMOS, type DemoModel } from './model.gen.ts'

// Intro is the first tab (id "intro", key "0", default on load); demos follow.
export const TAB_IDS = ['intro', ...DEMOS.map((d) => d.id)]

// Nav layout: consecutive demos sharing a groupId render clustered (e.g. the
// schema group's 3.1/3.2); everything else is a solo tab. Order follows DEMOS.
type NavItem = { kind: 'solo'; demo: DemoModel } | { kind: 'group'; groupId: string; label: string; members: DemoModel[] }
export const NAV_ITEMS: NavItem[] = (() => {
  const out: NavItem[] = []
  for (const d of DEMOS) {
    if (d.groupId) {
      const last = out[out.length - 1]
      if (last && last.kind === 'group' && last.groupId === d.groupId) {
        last.members.push(d)
        continue
      }
      out.push({ kind: 'group', groupId: d.groupId, label: d.groupLabel ?? d.groupId, members: [d] })
    } else {
      out.push({ kind: 'solo', demo: d })
    }
  }
  return out
})()

// Number-key routing keyed on the integer part of displayNum ("3.1" → "3").
// A key that maps to one demo selects it; a key that maps to a group (multiple
// members, e.g. "3" → [3.1, 3.2]) selects the first member, then CYCLES through
// the group on repeated presses while already inside it.
export const KEY_MAP: Record<string, DemoModel[]> = (() => {
  const m: Record<string, DemoModel[]> = {}
  for (const d of DEMOS) {
    const key = d.displayNum.split('.')[0]!
    ;(m[key] ??= []).push(d)
  }
  return m
})()

// ---------------------------------------------------------------------------
// nav tab (shared by solo tabs and grouped members). Shows the explicit
// displayNum (never an array index) and a PLANNED badge for aspirational demos.
// ---------------------------------------------------------------------------

// Notion-native tab: plain text, no pill/box. Active reads via ink weight + a
// single accent underline; the keyboard index is a hair-thin mono glyph, not a
// boxed kbd. `-mb-px` drops the underline onto the nav's own bottom hairline.
export const TabButton = ({ d, on, onClick }: { d: DemoModel; on: boolean; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className={
      on
        ? '-mb-px inline-flex items-center gap-1.5 border-b-2 border-accent px-3 py-2.5 text-[13px] font-medium text-fg'
        : '-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2.5 text-[13px] text-fg-muted hover:text-fg'
    }
  >
    <kbd className={`border-0 bg-transparent p-0 font-mono text-[11px] ${on ? 'text-accent' : 'text-fg-faint'}`}>
      {d.displayNum}
    </kbd>
    {d.tab}
  </button>
)

// intro is the first tab (id "intro") — a special static tab alongside DEMOS.
export const INTRO_ID = 'intro'
