import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url))

it('compiles responsive and hover media conditions under Bun', () => {
  const source = `
import * as stylex from '@stylexjs/stylex'
const styles = stylex.create({
  narrow: { display: { default: 'flex', '@media (max-width: 63.99rem)': 'block' } },
  hover: { color: { default: 'black', '@media (hover: hover)': 'blue' } },
})
`
  const script = [
    "const { transformSync } = require('@babel/core')",
    "const plugin = require('@stylexjs/babel-plugin')",
    `const source = ${JSON.stringify(source)}`,
    // The unpatched parser rejects identical valid queries intermittently under Bun.
    'for (let attempt = 0; attempt < 256; attempt++) {',
    '  const result = transformSync(source, {',
    "    filename: '/tmp/stylex-media-regression.js',",
    '    babelrc: false, configFile: false,',
    '    plugins: [[plugin, { enableMediaQueryOrder: true }]],',
    '  })',
    '  const rules = result.metadata.stylex',
    "  if (!rules.some((rule) => rule[1].ltr?.includes('@media (max-width: 63.99rem)')) ||",
    "      !rules.some((rule) => rule[1].ltr?.includes('@media (hover: hover)'))) {",
    "    throw new Error('StyleX did not emit responsive and hover CSS')",
    '  }',
    '}',
    "console.log('responsive and hover CSS emitted')",
  ].join('\n')
  const result = spawnSync(process.env.BUN_BIN ?? 'bun', ['-e', script], {
    cwd: packageRoot,
    encoding: 'utf8',
  })
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0,
    stdout: 'responsive and hover CSS emitted\n',
    stderr: '',
  })
})
