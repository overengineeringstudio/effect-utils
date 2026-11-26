/** Transport-only iroh endpoint, framed connections and serialized link ownership. */
export * from './errors.ts'
export { fromFramed, type Connection, type FramedConn } from './Connection.ts'
/** Serialized ownership of framed connections per remote endpoint. */
export * as Links from './Links.ts'
export { exclusiveLock } from './WebLock.ts'
export {
  IrohNode,
  layerWasm,
  N0_RELAYS,
  type IrohWasmModule,
  type IrohWasmNode,
  type NodeBuildError,
  type PeerAddress,
  type WasmNodeOptions,
} from './IrohNode.ts'
