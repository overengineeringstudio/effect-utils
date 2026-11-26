import type { Chunk, StorageAdapterInterface, StorageKey } from '@automerge/automerge-repo'

/**
 * Wraps a storage adapter so that it degrades to memory-only (documents live as long as the
 * repo) instead of breaking the repo when the backend is unavailable or starts failing —
 * e.g. IndexedDB in private mode or sandboxed frames.
 *
 * `make` may throw (it runs inside a try); return `undefined` for "no storage".
 */
export class SafeStorageAdapter implements StorageAdapterInterface {
  #inner: StorageAdapterInterface | undefined
  #failure: unknown
  readonly #onDisable: (error: unknown) => void

  constructor(
    make: () => StorageAdapterInterface | undefined,
    onDisable: (error: unknown) => void = () => {},
  ) {
    this.#onDisable = onDisable
    try {
      this.#inner = make()
    } catch (error) {
      this.#inner = undefined
      this.#failure = error
      onDisable(error)
    }
  }

  /** False once the backend failed (or never existed): nothing persists anymore. */
  get persistent() {
    return this.#inner !== undefined
  }

  /** Original backend failure, retained for typed durability errors after degradation. */
  get failure(): unknown {
    return this.#failure
  }

  #run = async <T>(fn: (s: StorageAdapterInterface) => Promise<T>, fallback: T): Promise<T> => {
    if (!this.#inner) return fallback
    try {
      return await fn(this.#inner)
    } catch (error) {
      this.#inner = undefined
      this.#failure = error
      this.#onDisable(error)
      return fallback
    }
  }

  load = (key: StorageKey) => this.#run((s) => s.load(key), undefined)
  save = (key: StorageKey, data: Uint8Array) => this.#run((s) => s.save(key, data), undefined)
  remove = (key: StorageKey) => this.#run((s) => s.remove(key), undefined)
  loadRange = (prefix: StorageKey) => this.#run<Chunk[]>((s) => s.loadRange(prefix), [])
  removeRange = (prefix: StorageKey) => this.#run((s) => s.removeRange(prefix), undefined)
}
