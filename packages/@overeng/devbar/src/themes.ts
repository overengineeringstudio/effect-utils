import * as stylex from '@stylexjs/stylex'

import { colors, fonts } from '@overeng/stylex-tokens/tokens.stylex'

import { devbarTokens } from './tokens.stylex.ts'

/** Explicit light theme for use inside a dark host or side-by-side previews. */
export const lightDevbarTheme = stylex.createTheme(devbarTokens, {
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

export const darkDevbarTheme = stylex.createTheme(devbarTokens, {
  canvas: colors.gray950,
  panel: colors.gray900,
  panelActive: colors.gray800,
  border: colors.gray700,
  text: colors.gray50,
  mutedText: colors.gray400,
  focusRing: colors.blue400,
  fontUi: fonts.sans,
  fontData: fonts.mono,
})
