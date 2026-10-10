# Effect Client — Requirements

## Context

**Role:** The Effect AI realization of the [public consumer contract](../requirements.md), using the [shared wire](../spec.md).

## Assumptions

- **AIG.EFF-A01 Caller-owned transport:** Consumers provide an Effect HTTP client and gateway-accessible model IDs.

## Acceptable Tradeoffs

- **AIG.EFF-T01 Provider composition:** Effect AI owns provider decoding, schema checking, and error behavior rather than a second local provider implementation.

## Requirements

### Must compose the Effect AI surface

- **AIG.EFF-R01 Model layers:** Provide both a configured LanguageModel layer and a reusable client layer with per-call model selection; preserve advertised model IDs. _refines: AIG-R01, AIG-R04._
- **AIG.EFF-R02 Redacted configuration:** Explicit connection settings accept a redacted bearer; config layers read the shared URL/token environment convention and do not send Authorization without a token. _refines: AIG-R02._
- **AIG.EFF-R03 Streaming usage:** Request streaming usage and expose provider-supplied counts through Effect AI. _refines: AIG-R03._
- **AIG.EFF-R04 Checked structured values:** Compose Effect AI object generation so requested formatting reaches the gateway and decoding validates the caller's original schema or fails. _refines: AIG-R05, AIG-R06._
- **AIG.EFF-R05 Typed native decisions:** Provide explicit/config DecisionModel layers over schema-encoded input and Effect's classify/probability/rate definitions, including a documented default model and validated answers. _refines: AIG-R07, AIG-R08._
- **AIG.EFF-R06 Caller-owned runtime:** Consumers supply HttpClient and telemetry runtime layers; the package does not own provider credentials or gateway policy. _refines: AIG-R09._
- **AIG.EFF-R07 Visible errors:** Preserve Effect AI transport/provider errors and reject invalid structured or decision answers rather than coercing success. _refines: AIG-R10._
- **AIG.EFF-R08 Tool exchanges:** Preserve Effect AI tool-call definitions, results, and streamed arguments without implicit application tool execution by the wrapper. _refines: AIG-R11._
- **AIG.EFF-R09 GenAI spans:** Integrate client operations with caller-provided OpenTelemetry and retain stream lifetime, usage, and failure visibility without default content capture. _refines: AIG-R12._
