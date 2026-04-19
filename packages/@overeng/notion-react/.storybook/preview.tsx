import type { Preview } from '@storybook/react'
import type { ReactNode } from 'react'

import '../src/web/vendored-notion.css'
import '../src/web/styles.css'

/**
 * Per R21 + T05 in `context/vrs/requirements.md`, the web renderer under
 * `src/web/` is explicitly a preview surface — not a production Notion
 * renderer. DOM, CSS hooks, and component props may change without
 * deprecation. This banner makes that visible in every story so reviewers
 * do not file "doesn't match Notion pixel-for-pixel" bugs against it.
 */
const PreviewBanner = () => (
  <div
    style={{
      position: 'fixed',
      top: 0,
      right: 0,
      padding: '4px 10px',
      background: '#fbe4e4',
      color: '#8c2b2b',
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      borderBottomLeftRadius: 4,
      zIndex: 9999,
      letterSpacing: 0.3,
    }}
  >
    Preview — not production Notion
  </div>
)

/**
 * Wrap every story in `.notion-page` so (a) the vendored-notion.css design
 * tokens (scoped under `.notion-page`) resolve, and (b) block-level
 * selectors inherit the intended visual context. Individual stories can
 * still compose `<Page>` explicitly — `.notion-page` nesting is harmless.
 */
const StorybookDecorator = ({ children }: { children: ReactNode }) => (
  <>
    <PreviewBanner />
    <div className="notion-page">{children}</div>
  </>
)

const preview: Preview = {
  decorators: [
    (Story) => (
      <StorybookDecorator>
        <Story />
      </StorybookDecorator>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
    backgrounds: {
      default: 'notion',
      values: [{ name: 'notion', value: '#ffffff' }],
    },
  },
}

export default preview
