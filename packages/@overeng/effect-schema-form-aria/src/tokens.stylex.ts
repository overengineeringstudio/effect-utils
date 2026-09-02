import * as stylex from '@stylexjs/stylex'

import { colors, shadows } from '@overeng/stylex-tokens/tokens.stylex'

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
  // One step darker than the obvious `blue500`, which is a legibility fact
  // rather than a preference: white body text on `blue500` measures 3.76:1 and
  // the accessibility gate failed ten stories on it. `blue600` measures 5.25:1.
  // Anything placed on this token as a background must use `on-primary`.
  primary: colors.blue600,
  /** Foreground for text and icons drawn on top of `primary`. */
  'on-primary': colors.white,
  accent: colors.blue600,
  /** Elevation for surfaces that float above the page, such as a popover. */
  'shadow-raised': shadows.lg,
})
