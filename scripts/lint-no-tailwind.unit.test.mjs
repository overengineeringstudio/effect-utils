import { test } from 'node:test'
import { deepStrictEqual, throws } from 'node:assert/strict'
import { inspectTailwind } from './lint-no-tailwind.mjs'

const fixtures = [
  { path: 'docs/package.json', content: '{\n  "devDependencies": {\n    "@tailwindcss/vite": "4"\n  }\n}' },
  { path: 'docs/src/site.css', content: '/* @apply ignored; */\n@import "tailwindcss";\n.card { @apply flex; }' },
  { path: 'docs/astro.config.ts', content: "import tailwindcss from '@tailwindcss/vite'" },
  { path: 'docs/tailwind.config.mjs', content: 'export default {}' },
  { path: 'packages/core/package.json', content: '{"peerDependencies":{"tailwindcss":"4"}}' },
  { path: 'packages/core/src/index.ts', content: "// import '@tailwindcss/vite'\nconst x = require('tailwindcss/plugin')" },
  { path: 'packages/@local/demo/example/src/site.css', content: '@tailwind base;' },
  { path: 'packages/@local/demo/src/site.css', content: '@apply text-red-500;' },
  { path: 'src/clean.css', content: "/* @import 'tailwindcss'; */\n@import '@overeng/stylex-tokens/preflight.css';" },
]

test('reports dependency, import, config, and CSS violations with source lines', () => {
  deepStrictEqual(inspectTailwind(fixtures), [
    'docs/package.json:3: devDependencies.@tailwindcss/vite is a Tailwind dependency; remove it and use StyleX',
    'docs/src/site.css:2: Tailwind CSS directive; replace it with StyleX or @overeng/stylex-tokens/preflight.css',
    'docs/src/site.css:3: Tailwind CSS directive; replace it with StyleX or @overeng/stylex-tokens/preflight.css',
    'docs/astro.config.ts:1: Tailwind import @tailwindcss/vite; replace it with StyleX',
    'docs/tailwind.config.mjs:1: Tailwind config; remove it and use StyleX',
    'packages/core/package.json:1: peerDependencies.tailwindcss is a Tailwind dependency; remove it and use StyleX',
    'packages/core/src/index.ts:2: Tailwind import tailwindcss/plugin; replace it with StyleX',
    'packages/@local/demo/example/src/site.css:1: Tailwind CSS directive; replace it with StyleX or @overeng/stylex-tokens/preflight.css',
    'packages/@local/demo/src/site.css:1: Tailwind CSS directive; replace it with StyleX or @overeng/stylex-tokens/preflight.css',
  ])
})

test('permits StyleX and ignores commented Tailwind directives', () => {
  deepStrictEqual(inspectTailwind(fixtures.slice(-1)), [])
})

test('path-scoped exceptions leave library packages guarded', () => {
  const exceptions = [
    { path: 'docs/**', reason: 'Published documentation app uses Tailwind' },
    { path: 'packages/@local/**/example/**', reason: 'Standalone example app' },
  ]
  deepStrictEqual(inspectTailwind(fixtures, exceptions), [
    'packages/core/package.json:1: peerDependencies.tailwindcss is a Tailwind dependency; remove it and use StyleX',
    'packages/core/src/index.ts:2: Tailwind import tailwindcss/plugin; replace it with StyleX',
    'packages/@local/demo/src/site.css:1: Tailwind CSS directive; replace it with StyleX or @overeng/stylex-tokens/preflight.css',
  ])
})

test('rejects unreasoned or imprecise exceptions', () => {
  throws(() => inspectTailwind([], [{ path: 'docs/**', reason: '' }]), /nonempty reason/)
  throws(() => inspectTailwind([], [{ path: 'docs', reason: 'too broad' }]), /path ending/)
})
