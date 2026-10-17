import { tsconfigJson } from '../../../genie/repo.ts'

export default tsconfigJson({
  extends: '../tsconfig.json',
  compilerOptions: { composite: false, noEmit: true },
  include: ['static-safety.ts', '../src/**/*', '../generated/**/*'],
  exclude: [],
})
