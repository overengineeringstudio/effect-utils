import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { StorybookConfig } from '@storybook/react-vite'
import { mergeConfig, type PluginOption } from 'vite'

// The reusable kit lives in a SIBLING dir (../../kit). Stories are colocated there.
const APP_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/\.storybook$/, '')
const DASHBOARD_DIR = resolve(APP_DIR, '..')

const config: StorybookConfig = {
  // Colocated kit stories (NOT app/src — that is the control-dashboard app, owned
  // elsewhere). Point Storybook at the shared component kit.
  stories: ['../../kit/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-essentials', '@storybook/addon-links'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  // @storybook/react-vite auto-loads the app's vite.config.ts and merges it. That
  // config is wired for the REAL app (tailwind, a screenplay codegen plugin, and a
  // tailscale-specific server block) and adds its own @vitejs/plugin-react — none of
  // which we want here, and a second react plugin breaks Fast Refresh ("preamble").
  // So we take deliberate control of the merged config instead of inheriting it:
  //   - drop the app-only plugins (tailwind, screenplay codegen) — the kit uses plain
  //     className strings against kit-components.css, not Tailwind utilities;
  //   - de-duplicate react plugins by name so exactly ONE react transform runs;
  //   - keep resolve.dedupe:['react','react-dom'] (the useRef-null crash fix — the
  //     kit's node_modules is a symlink to explainers', so dual-React is a live path);
  //   - allow serving the sibling dashboard dir (kit-components.css + kit sources);
  //   - neutralize the tailscale server block so `storybook dev` is reachable locally.
  viteFinal: async (cfg) => {
    const merged = mergeConfig(cfg, {
      resolve: { dedupe: ['react', 'react-dom'] },
      server: {
        fs: { allow: [DASHBOARD_DIR] },
        // Discard the app's tailscale-specific server wiring (fixed 127.0.0.1:5174,
        // allowedHosts/hmr/strictPort) so the SB dev server binds normally.
        host: undefined,
        port: undefined,
        strictPort: false,
        allowedHosts: undefined,
        hmr: undefined,
      },
    })

    // Strip app-only plugins and collapse duplicate-named plugins (react is added by
    // both the app config and the SB framework preset — keep the first of each name).
    const DROP = new Set(['screenplay-model-codegen'])
    const seen = new Set<string>()
    const keep = (p: PluginOption): boolean => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return true
      const name = (p as { name?: string }).name ?? ''
      if (DROP.has(name) || name.startsWith('@tailwindcss')) return false
      if (name.startsWith('vite:react') || name === 'vite-plugin-react') {
        if (seen.has(name)) return false
        seen.add(name)
      }
      return true
    }
    const filterPlugins = (plugins: PluginOption[] | undefined): PluginOption[] =>
      (plugins ?? []).flat(Infinity as 1).filter(keep) as PluginOption[]

    merged.plugins = filterPlugins(merged.plugins)
    return merged
  },
}

export default config
