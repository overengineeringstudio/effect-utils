import * as stylex from '@stylexjs/stylex'

import { colors, fonts } from '@overeng/stylex-tokens/tokens.stylex'

/** Semantic defaults for the developer bar; hosts can override these with a theme class. */
export const devbarTokens = stylex.defineVars({
  canvas: colors.white,
  panel: colors.gray50,
  panelActive: colors.gray100,
  border: colors.gray200,
  text: colors.gray950,
  mutedText: colors.gray600,
  focusRing: colors.blue600,
  fontUi: fonts.sans,
  fontData: fonts.mono,
})
