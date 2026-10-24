import { Schema } from 'effect'

import { swiftFile } from '../../../../genie.ts'
import { options } from '../../../contracts.ts'

export default swiftFile({
  schemas: { SecondaryNumber: Schema.Int.check(Schema.isBetween({ minimum: 3, maximum: 9 })) },
  options: {
    ...options,
    filename: 'Secondary.swift',
    header:
      'Inputs: Secondary.swift.genie.ts, src/fixtures/contracts.ts and schema-codegen{,-swift}/src. Regenerate: devenv tasks run genie:run',
  },
})
