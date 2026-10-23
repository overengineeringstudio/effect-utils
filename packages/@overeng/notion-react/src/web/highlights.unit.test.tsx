// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HighlightsRender } from './highlights.tsx'

const container = document.createElement('div')
const root = createRoot(container)

afterEach(async () => {
  await act(async () => root.render(null))
})

describe('web code highlighting', () => {
  it('renders TypeScript with githubLight token styles', async () => {
    await act(async () => {
      root.render(<HighlightsRender language="ts">{'const answer = 42'}</HighlightsRender>)
    })
    await vi.waitFor(() => expect(container.querySelector('div.notion-code pre')).not.toBeNull())
    const tokens = Array.from(container.querySelectorAll('code span'))
    expect(tokens.some((token) => token.textContent === 'const' && token.getAttribute('style')?.includes('#d73a49'))).toBe(true)
    expect(tokens.some((token) => token.textContent === '42' && token.getAttribute('style')?.includes('#005cc5'))).toBe(true)
    expect(container.textContent).toBe('const answer = 42')
  })

  it('keeps unsupported languages plain and escaped without throwing', async () => {
    await act(async () => {
      root.render(<HighlightsRender language="kdl">{'node <tag> & "value"'}</HighlightsRender>)
    })
    expect(container.innerHTML).toMatchInlineSnapshot(
      `"<pre class=\"notion-code\" data-language=\"kdl\"><code>node &lt;tag&gt; &amp; \"value\"</code></pre>"`,
    )
  })

  it('does not retain highlighted HTML when the language becomes unsupported', async () => {
    await act(async () => {
      root.render(<HighlightsRender language="ts">{'const answer = 42'}</HighlightsRender>)
    })
    await vi.waitFor(() => expect(container.querySelector('div.notion-code pre')).not.toBeNull())
    await act(async () => {
      root.render(<HighlightsRender language="kdl">{'node <tag>'}</HighlightsRender>)
    })
    expect(container.innerHTML).toBe(
      '<pre class="notion-code" data-language="kdl"><code>node &lt;tag&gt;</code></pre>',
    )
  })

  it('preserves nested React children instead of flattening them', async () => {
    await act(async () => {
      root.render(<HighlightsRender language="ts"><strong>const</strong>{' answer = 42'}</HighlightsRender>)
    })
    expect(container.innerHTML).toBe(
      '<pre class="notion-code" data-language="ts"><code><strong>const</strong> answer = 42</code></pre>',
    )
  })
})
