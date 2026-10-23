import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HighlightsRender } from './highlights.tsx'

describe('server code rendering', () => {
  it('renders escaped plain code even when the highlighting peer is installed', () => {
    expect(
      renderToStaticMarkup(
        <HighlightsRender language="ts">{'const html = "<tag> & value"'}</HighlightsRender>,
      ),
    ).toMatchInlineSnapshot(
      `"<pre class="notion-code" data-language="ts"><code>const html = &quot;&lt;tag&gt; &amp; value&quot;</code></pre>"`,
    )
  })

  it('keeps the default language label for unlabelled blocks', () => {
    expect(
      renderToStaticMarkup(
        <HighlightsRender language={undefined}>{'plain <text>'}</HighlightsRender>,
      ),
    ).toBe(
      '<pre class="notion-code" data-language="plain text"><code>plain &lt;text&gt;</code></pre>',
    )
  })
})
