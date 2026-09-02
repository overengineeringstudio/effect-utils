import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { loadRealPnpmLockData } from './generate.ts'
import { makePnpmBuckProjection, renderPnpmBuck } from './pnpm-lock-buck.ts'

const { metadata, sidecar } = loadRealPnpmLockData()
const projection = makePnpmBuckProjection({ metadata, sidecar })

export default createGenieOutput({
  data: projection,
  stringify: () => renderPnpmBuck(projection),
})
