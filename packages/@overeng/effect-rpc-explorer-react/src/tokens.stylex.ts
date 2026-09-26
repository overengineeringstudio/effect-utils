import * as stylex from '@stylexjs/stylex'

import { colors, fonts, fontSizes, spacing } from '@overeng/stylex-tokens/tokens.stylex'

/** Package-local semantic tokens. Hosts may apply a compatible StyleX theme class. */
export const explorerTokens = stylex.defineVars({
  canvas: colors.white,
  panel: colors.gray50,
  'panel-raised': colors.gray100,
  'panel-active': colors.blue50,
  border: colors.gray200,
  text: colors.gray950,
  'muted-text': colors.gray600,
  success: colors.green700,
  failure: colors.red700,
  warning: colors.amber700,
  fault: colors.orange700,
  info: colors.blue700,
  'focus-ring': colors.blue600,
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
