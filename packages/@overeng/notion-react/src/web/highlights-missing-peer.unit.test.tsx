// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

import { HighlightsRender } from './highlights.tsx'

// A rejected dynamic import is how an absent optional peer reaches the renderer.
const { peerImport } = vi.hoisted(() => ({ peerImport: vi.fn() }))
vi.mock('@pierre/highlights', () => {
  peerImport()
  throw new Error('Optional highlighting peer is not installed')
})

it('keeps escaped plain code when the optional peer cannot load', async () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <HighlightsRender language="ts">{'const html = "<tag> & value"'}</HighlightsRender>,
      )
    })
    await vi.waitFor(() => expect(peerImport).toHaveBeenCalledOnce())
    expect(container.innerHTML).toBe(
      '<pre class="notion-code" data-language="ts"><code>const html = "&lt;tag&gt; &amp; value"</code></pre>',
    )
  } finally {
    await act(async () => root.unmount())
  }
})
