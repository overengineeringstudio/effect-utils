import { Schema } from 'effect'

/** Portable nonempty identifier text; whitespace is never silently normalized. */
export const TrimmedNonEmptyString = Schema.NonEmptyString.check(Schema.isTrimmed())
/** Nonnegative integer version used by neutral registry and evidence DTOs. */
export const NonNegativeVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** One wire-compatible digest brand for unsigned registry and observation identities. */
export const Sha256Fingerprint = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/)),
  Schema.brand('SchemaRegistry.Sha256Fingerprint'),
  Schema.annotate({ identifier: 'SchemaRegistry.Sha256Fingerprint' }),
)
/** Locale-independent JavaScript code-unit ordering used by canonical projections. */
export const compareText = (args: { readonly left: string; readonly right: string }): number =>
  args.left < args.right ? -1 : args.left > args.right ? 1 : 0
