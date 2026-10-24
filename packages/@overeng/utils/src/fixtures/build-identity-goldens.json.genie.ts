import golden from '../../../../../swift/OverengKit/Tests/OverengKitTests/Goldens/identity.json' with { type: 'json' }
import { createGenieOutput } from '../../../genie/src/runtime/core.ts'

// Generated projection: build-identity-goldens.json must not be edited by hand.
// Sole semantic input: the contract-owned SwiftPM JSON imported above.
// Regenerate: devenv tasks run genie:run; freshness: devenv tasks run genie:check.
// No metadata is injected, preserving byte identity with the authority.
export default createGenieOutput({
  data: golden,
  stringify: () => `${JSON.stringify(golden, null, 2)}\n`,
})
