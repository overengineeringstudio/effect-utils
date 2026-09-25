# 0002 - Capture-policy prototype (rc.115)

Non-normative evidence for [../01-core/spec.md](../01-core/spec.md) and
[../.decisions/0002-fail-closed-whole-channel-capture.md](../.decisions/0002-fail-closed-whole-channel-capture.md).

## Question

A seven-channel policy can use only public Effect rc.115 metadata, resolve the
four intended precedence levels, and prevent a sentinel secret from entering
retained omit/redact events when redaction precedes detached normalization.

## Method

A disposable TypeScript prototype executed against Effect source revision
`755e863a793e5621183e7992cb3f85d29030ad7b` (`4.0.0-rc.115`) constructed
annotated/unannotated unary and streaming RPCs in an `RpcGroup`. It separately
resolved and captured request payload, success, typed
failure, defect, stream element, stream error, and headers. It tested host,
RPC-Context, root-Schema, and package-default policy sources and recursively
inspected the complete stored object graph for a sentinel secret. It also
exercised a nested JSON-compatible Schema annotation case and `Schema.Redacted`.
The temporary prototype was removed after execution; it was not a tracked test
or persistent artifact.

## Result

| Finding                      | Result                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Public metadata survival     | `RpcGroup` retained RPC Context annotations, root Schema annotations, and public stream element/error schemas |
| Four-level precedence        | host omit > RPC redact > Schema redact > default omit resolved as designed                                    |
| Seven channels               | all seven were selected and captured independently; headers had no Schema layer                               |
| Storage oracle               | omit/redact stored graphs contained no sentinel secret; omit produced no content value                        |
| Nested schema experiment     | simple JSON-compatible nested Struct metadata could guide a sanitizer, but only for that limited shape        |
| Redacted ordinary inspection | string/JSON inspection produced a masked placeholder                                                          |
| Redacted codec hazard        | permissive `Schema.toCodecJson` encoded the original secret; `disallowJsonEncode` rejected encoding           |

## Conclusion

The hypothesis is supported for whole-channel public metadata and pre-storage
normalization. It does not establish a sound generic nested Schema traversal or
prove arbitrary host transforms safe.

## VRS Impact

Default omission, independent channel resolution, pre-storage transform plus
normalization, and Redacted replacement are supported by the observed public
surface. Root whole-channel policy is the v1 contract. Generic nested
field-policy traversal is not soundly established: `Schema.Top` has no generic
public field traversal, and JSON Schema projection is best-effort/canonical
encoded JSON rather than arbitrary decoded values. `Schema.toCodecJson` must
not be used as the capture sanitizer. The prototype did not build a UI, make
active network calls, or prove arbitrary host transforms safe.
