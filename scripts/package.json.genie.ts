import { pkg } from '../genie/repo.ts'

export default pkg({
  name: 'effect-utils-scripts',
  private: true,
  type: 'module',
  dependencies: [
    '@effect/cli',
    '@effect/platform',
    '@effect/platform-node',
    '@overeng/genie',
    '@overeng/utils',
    'effect',
  ],
  devDependencies: ['@types/node', 'typescript'],
})
