import { firstPartyPackageDefaults, packageJson } from '../../../../../genie/internal.ts'
import utilsPackage from '../../package.json.genie.ts'

/** The fixture exercises the same adapter dependency versions as its owner. */
const installedVersion = ({ name }: { name: string }): string => {
  const version =
    utilsPackage.data.devDependencies?.[name] ?? utilsPackage.data.dependencies?.[name]
  if (version === undefined) throw new Error(`Missing utils fixture dependency: ${name}`)
  return version
}

export default packageJson({
  name: 'fixture-next',
  ...firstPartyPackageDefaults,
  private: true,
  packageManager: 'pnpm@12.17.0',
  dependencies: Object.fromEntries(
    ['next', 'react', 'react-dom', '@stylexjs/stylex', 'postcss'].map((name) => [
      name,
      installedVersion({ name }),
    ]),
  ),
  devDependencies: {
    ...Object.fromEntries(
      [
        '@types/react',
        '@types/node',
        'babel-loader',
        '@stylexjs/babel-plugin',
        '@stylexjs/postcss-plugin',
      ].map((name) => [name, installedVersion({ name })]),
    ),
    // Next requires the classic lib/typescript.js layout, not native TS 7.
    typescript: '5.9.3',
  },
})
