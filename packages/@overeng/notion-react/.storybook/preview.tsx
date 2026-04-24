import type { Preview } from '@storybook/react'
import type { ReactNode } from 'react'

import { NotionUrlProviderProvider } from '../src/renderer/url-provider.ts'
import '../src/web/vendored-notion.css'
import '../src/web/styles.css'
import '../src/web/katex.css'

/**
 * Per R21 + T05 in `docs/vrs/requirements.md`, the web renderer under
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
 * Mirror react-notion-x's root DOM so every vendored rule resolves:
 * `.notion` applies font-family + color resets, `.notion-page` holds the
 * design tokens, and `.notion-page-content` is the flex-column that makes
 * inline-display blocks (e.g. `.notion-h`) stack vertically.
 *
 * Stories that compose `<Page>` explicitly nest harmlessly inside this wrapper.
 */
/**
 * Registry mapping `ChildPage` / `LinkToPage` / `Mention` pageIds (sourced from
 * `blockKey` or an explicit `pageId` prop in stories) to the storyId that
 * renders that sub-page as a standalone `<Page>`. Keeping this co-located with
 * Storybook config rather than in library code preserves the boundary: the
 * preview surface owns routing; the library owns components.
 *
 * When a pageId is absent from this registry, the resolver returns `undefined`
 * and ChildPage/LinkToPage render as inert anchors — the same silent-miss
 * behaviour a production host gets for unresolved pages.
 */
const subPageStoryRegistry: Record<string, string> = {
  onboarding: 'pages-subpage--onboarding',
  'engineering-guide': 'pages-subpage--engineering-guide',
  'review-etiquette': 'pages-subpage--review-etiquette',
  'ops-runbook': 'pages-subpage--ops-runbook',
  spec: 'pages-subpage--spec',
  'launch-runbook': 'pages-subpage--launch-runbook',
}

/**
 * Storybook preview URL resolver. Looks up the clicked pageId in the sub-page
 * registry and returns a Storybook shell URL targeting the matching story.
 *
 * - **Absolute `/?path=...`**: the resolver runs inside the story iframe
 *   (`/iframe.html?...`). A relative `?path=...` would swap the query of the
 *   iframe URL and load the story raw (no sidebar/toolbar). An absolute
 *   root-relative path navigates to the Storybook shell at `/`, which then
 *   picks up `?path=` and renders the story inside its iframe again — keeping
 *   the chrome intact.
 * - **`target: '_top'`**: without it the anchor navigates the iframe itself
 *   instead of the top window, leaving the user stranded in a nested-frame
 *   view. `_top` breaks out to the top-level window.
 */
const storybookUrlResolver = ({ pageId }: { readonly pageId: string }) => {
  const storyId = subPageStoryRegistry[pageId]
  if (storyId === undefined) return undefined
  return {
    href: `/?path=/story/${storyId}`,
    target: '_top' as const,
  }
}

const StorybookDecorator = ({ children }: { children: ReactNode }) => (
  <NotionUrlProviderProvider value={{ resolve: storybookUrlResolver }}>
    <PreviewBanner />
    <div className="notion notion-app">
      <div className="notion-page">
        <div className="notion-page-content">{children}</div>
      </div>
    </div>
  </NotionUrlProviderProvider>
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
