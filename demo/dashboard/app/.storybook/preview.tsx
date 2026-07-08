import * as React from 'react'
import type { Decorator, Preview } from '@storybook/react'
// CSS, in the SAME order the app mounts it (main.tsx), minus the dashboard's own
// index.css (Tailwind + dashboard chrome, irrelevant to the isolated kit) and the
// per-explainer content CSS (explainer-specific, not kit components):
//   kit-components.css — the authored kit component styles (state-machine + keyframes)
//   explainer.css      — the TOKEN BRIDGE: defines --accent/--line/--muted/… scoped to
//                        `.explainer-root`. WITHOUT this wrapper the tokens are undefined
//                        and every kit component renders unstyled.
import '../../kit/kit-components.css'
import '../src/explainer.css'

type Theme = 'light' | 'dark'

/**
 * Token-bridge + theme decorator. Every kit component resolves its design tokens
 * from `.explainer-root` (see explainer.css), so we wrap each story in it. The kit
 * tokens flip on `:root[data-theme=…]` / prefers-color-scheme, so a real dark demo
 * needs the attribute stamped on the HTML root — a backgrounds swap alone won't move
 * the tokens. We stamp `data-theme` from the toolbar global and back the canvas with
 * the token `--bg` so light/dark actually read correctly.
 */
const withKitTheme: Decorator = (Story, context) => {
  const theme = (context.globals.theme as Theme) ?? 'light'
  React.useEffect(() => {
    const root = document.documentElement
    const prev = root.getAttribute('data-theme')
    root.setAttribute('data-theme', theme)
    return () => {
      if (prev == null) root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', prev)
    }
  }, [theme])
  return (
    <div
      className="explainer-root"
      style={{ background: 'var(--bg)', color: 'var(--ink)', padding: '24px', minHeight: '100vh' }}
    >
      <Story />
    </div>
  )
}

const preview: Preview = {
  decorators: [withKitTheme],
  globalTypes: {
    theme: {
      description: 'Kit design-token theme (light / dark)',
      defaultValue: 'light',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light', icon: 'sun' },
          { value: 'dark', title: 'Dark', icon: 'moon' },
        ],
        dynamicTitle: true,
      },
    },
  },
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    // The wrapper already paints the token-driven --bg; disable the addon's own
    // canvas backgrounds so they don't fight the theme decorator.
    backgrounds: { disable: true },
  },
}

export default preview
