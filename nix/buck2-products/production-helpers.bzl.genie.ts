import { productionHelperBuck } from '../../genie/buck2/production-helpers.ts'
import sourceBuck from '../../packages/@overeng/buck2-tools/BUCK.genie.ts'
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import inventory from './production-helpers.json.genie.ts'

export default createGenieOutput({
  data: inventory.data,
  stringify: (context) =>
    productionHelperBuck({ source: sourceBuck.stringify(context), files: inventory.data.files }),
})
