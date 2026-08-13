# Target Execution Spec

This document specifies the portable action lifecycle. It builds on
[requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** executor inputs, action lifecycle, typed results, and authority
parity.

**Does not define:** language-specific resolver behavior or live consumer work.

## Action Lifecycle

```text
ConfiguredOperation
  -> validate typed payload and declared providers
  -> execute tool without ambient discovery
  -> validate declared outputs or semantic verdict
  -> return typed provider + native Buck result
```

The public kernel owns validation and lifecycle mechanics. Repository adapters
own which operations exist and which dependency closure each receives.
Ecosystem-specific executors translate typed payloads into tool protocols; they
do not select undeclared inputs or policy.

## Result Providers

| Operation kind | Required provider data                                           |
| -------------- | ---------------------------------------------------------------- |
| Check or lint  | semantic verdict, tool identity, configured operation identity   |
| Test           | semantic verdict, structured test summary, declared test outputs |
| Compilation    | declared output roles and content identities                     |
| Product        | `BuildProduct` descriptor path and payload path                  |

Stdout and stderr remain diagnostic streams. They are not the product or
verdict protocol.

## Authority Gate

For one exact operation tuple, admission evidence contains:

1. baseline and Buck executions over equivalent declared inputs;
2. a success case and representative semantic failure;
3. a missing-input or undeclared-access failure;
4. relevant and irrelevant mutation controls;
5. output or verdict equivalence;
6. proof that normal developer and CI entrypoints no longer invoke the former
   producer after transfer.

An unsupported tuple remains unsupported; it does not inherit admission from a
neighboring platform or operation.
