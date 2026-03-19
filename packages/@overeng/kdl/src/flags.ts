/** Flags to turn language features on or off */
export interface ParserFlags {
  /**
   * Support suffixed numbers using a proposal that might not make it into the language.
   *
   * If enabled, decimal numbers can have a suffix used as tag for the value,
   * which implies a number cannot have both a tag and a suffix.
   */
  experimentalSuffixedNumbers: boolean
}

export const resolveFlags = (flags: Partial<ParserFlags> = {}): ParserFlags => ({
  experimentalSuffixedNumbers: flags.experimentalSuffixedNumbers ?? false,
})
