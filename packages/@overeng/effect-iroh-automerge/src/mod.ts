/** Optional automerge-repo integration over the transport-only effect-iroh-browser package. */
export { IrohNetworkAdapter, deviceIdOfPeer, remotePeers } from './IrohNetworkAdapter.ts'
export {
  dialBackoff,
  makeNet,
  Net,
  RepoNetwork,
  UNREACHABLE_AFTER,
  Wakeups,
  type NetStatus,
  type PeerState,
  type Session,
} from './Net.ts'
export { mesh } from './mesh.ts'
