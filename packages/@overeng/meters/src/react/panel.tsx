import * as React from 'react'

import type { CanvasBlockSpec, MeterTheme } from '../canvas/index.ts'

/** Renderer-only list/detail composition; selection, persistence, and detail content belong to the host. */
export interface MetersPanelProps {
  readonly blocks: readonly CanvasBlockSpec[]
  readonly theme: MeterTheme
  readonly selected: string | undefined
  readonly onSelect: (selection: { readonly id: string }) => void
  readonly renderDetail: (block: CanvasBlockSpec) => React.ReactNode
}

/** List every supplied meter without acquiring a session lease or owning selection state. */
export const MetersPanel = ({
  blocks,
  theme,
  selected,
  onSelect,
  renderDetail,
}: MetersPanelProps): React.ReactNode => {
  const detailId = React.useId()
  const block = blocks.find((item) => item.id === selected)
  return (
    <div
      style={{
        display: 'flex',
        flexGrow: 1,
        minHeight: 0,
        minWidth: 0,
        color: theme.foreground,
        background: theme.background,
      }}
    >
      <div
        role="group"
        aria-label="Meter selection"
        style={{
          flexShrink: 0,
          width: '12rem',
          maxWidth: '40%',
          overflow: 'auto',
          borderRight: `1px solid ${theme.border}`,
        }}
      >
        <ul style={{ listStyle: 'none', margin: 0, padding: 4 }}>
          {blocks.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={item.id === block?.id}
                aria-controls={detailId}
                onClick={() => onSelect({ id: item.id })}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 8px',
                  border: 0,
                  borderRadius: 4,
                  textAlign: 'left',
                  overflowWrap: 'anywhere',
                  font: 'inherit',
                  color: theme.foreground,
                  background: item.id === block?.id ? theme.border : 'transparent',
                  cursor: 'pointer',
                  outlineColor: theme.focus,
                  outlineOffset: -2,
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div id={detailId} style={{ flexGrow: 1, minWidth: 0, minHeight: 0, overflow: 'auto' }}>
        {block !== undefined ? (
          renderDetail(block)
        ) : (
          <p style={{ padding: '0 1rem', color: theme.muted }}>
            {blocks.length === 0 ? 'No meters configured.' : 'Select a meter to view its details.'}
          </p>
        )}
      </div>
    </div>
  )
}
