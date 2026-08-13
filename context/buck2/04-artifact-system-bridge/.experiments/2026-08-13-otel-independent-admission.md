# OTEL Independent Admission Authority

## Status

Structural proof complete on 2026-08-13. Product realization is **NO VERDICT**
because the host had less than 60 GB free and heavy work was not admitted.

## Question

Can the repository keep an executable Buck-to-Nix smoke gate without letting
the product-producing invocation authorize its own descriptor identity?

## Result

The shared runner has two explicit modes:

| Mode    | Descriptor expectation                                  | Required CI | Authority             |
| ------- | ------------------------------------------------------- | ----------- | --------------------- |
| `smoke` | Derived from the produced descriptor                    | Yes         | Plumbing only         |
| `admit` | `BUCK2_OTEL_EXPECTED_DESCRIPTOR_DIGEST` from the caller | No          | Independent admission |

Both modes keep `linux/x86_64/musl` as literal Nix policy. Both first substitute
a different, still schema-valid semantic recipe while retaining the original
expected digest and require a descriptor-identity rejection. The unchanged
descriptor must then import under the same pin.

Focused evidence covered shell syntax, Nix parsing, task wiring, the absence of
an admission fallback, and the exact RED/GREEN data flow. It did not realize the
cross toolchain, Buck product, or Nix import.
