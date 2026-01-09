import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/effect-schema-form',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  devDependencies: ['@types/react', 'effect', 'react', 'vitest'],
  peerDependencies: {
    effect: '^',
    react: '^',
  },
})
