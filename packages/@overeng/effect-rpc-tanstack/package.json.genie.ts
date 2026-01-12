import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/effect-rpc-tanstack',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
    './client': './src/client.ts',
    './server': './src/server.ts',
    './router': './src/router.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './client': './dist/client.js',
      './server': './dist/server.js',
      './router': './dist/router.js',
    },
  },
  devDependencies: {
    '@effect/platform': catalog['@effect/platform'],
    '@effect/platform-node': catalog['@effect/platform-node'],
    '@effect/rpc': catalog['@effect/rpc'],
    '@tanstack/react-router': catalog['@tanstack/react-router'],
    '@tanstack/react-start': catalog['@tanstack/react-start'],
    '@types/react': catalog['@types/react'],
    effect: catalog.effect,
    react: catalog.react,
    'react-dom': catalog['react-dom'],
    vite: catalog.vite,
    vitest: catalog.vitest,
  },
  peerDependencies: {
    '@effect/platform': `^${catalog['@effect/platform']}`,
    '@effect/platform-node': `^${catalog['@effect/platform-node']}`,
    '@effect/rpc': `^${catalog['@effect/rpc']}`,
    '@tanstack/react-router': `^${catalog['@tanstack/react-router']}`,
    '@tanstack/react-start': `^${catalog['@tanstack/react-start']}`,
    effect: `^${catalog.effect}`,
    react: `^${catalog.react}`,
    'react-dom': `^${catalog['react-dom']}`,
  },
})
