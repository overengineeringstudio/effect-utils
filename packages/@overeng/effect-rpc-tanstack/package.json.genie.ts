import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
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
  devDependencies: [
    '@effect/platform',
    '@effect/platform-node',
    '@effect/rpc',
    '@tanstack/react-router',
    '@tanstack/react-start',
    '@types/react',
    'effect',
    'react',
    'react-dom',
    'vite',
    'vitest',
  ],
  peerDependencies: {
    '@effect/platform': '^',
    '@effect/platform-node': '^',
    '@effect/rpc': '^',
    '@tanstack/react-router': '^',
    '@tanstack/react-start': '^',
    effect: '^',
    react: '^',
    'react-dom': '^',
  },
})
