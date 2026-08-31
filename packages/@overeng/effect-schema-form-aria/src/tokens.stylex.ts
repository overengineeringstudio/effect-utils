import * as stylex from '@stylexjs/stylex'

import { colors } from '@overeng/stylex-preset/tokens.stylex'

/**
 * Semantic design tokens for effect-schema-form-aria.
 *
 * Components consume semantic names rather than palette steps. Defaults use
 * named design-system scale values so unconstrained raw colors are not the
 * easiest path.
 */
export const tokens = stylex.defineVars({
  ink: colors.neutral900,
  'subtle-ink': colors.gray500,
  'muted-ink': colors.gray400,
  border: colors.gray200,
  input: colors.white,
  surface: colors.gray50,
  'surface-raised': colors.gray100,
  primary: colors.blue500,
  accent: colors.blue500,
})
