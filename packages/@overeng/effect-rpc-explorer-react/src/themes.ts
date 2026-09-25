import * as stylex from '@stylexjs/stylex'

import { colors, fonts, fontSizes, spacing } from '@overeng/stylex-tokens/tokens.stylex'

import { explorerTokens } from './tokens.stylex.ts'

/** Dark theme class for hosts and Storybook; the default token values are light. */
export const darkExplorerTheme = stylex.createTheme(explorerTokens, {
  canvas: colors.gray950,
  panel: colors.gray900,
  'panel-raised': colors.gray800,
  'panel-active': colors.blue950,
  border: colors.gray700,
  text: colors.gray50,
  'muted-text': colors.gray400,
  success: colors.green400,
  failure: colors.red400,
  warning: colors.amber400,
  fault: colors.orange400,
  info: colors.blue400,
  'focus-ring': colors.blue400,
  'font-ui': fonts.sans,
  'font-data': fonts.mono,
  'font-size': fontSizes.xs,
  'density-gap': spacing[2],
  'density-inline': spacing[2],
  'density-block': spacing[1],
  'row-height': '2rem',
  'control-height': '1.75rem',
  'motion-attention': '900ms',
})
