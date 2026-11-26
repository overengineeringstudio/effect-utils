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

  constructor({
    make,
    onDisable = () => {},
  }: {
    readonly make: () => StorageAdapterInterface | undefined
    readonly onDisable?: (error: unknown) => void
  }) {
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

  /** Loads a value, returning no value if persistence is unavailable. */
  load = (key: StorageKey) => this.#run({ fn: (s) => s.load(key), fallback: undefined })

  /** Saves using the positional signature required by automerge-repo's storage interface. */
  save = (...[key, data]: Parameters<StorageAdapterInterface['save']>) =>
    this.#run({ fn: (s) => s.save(key, data), fallback: undefined })

  /** Removes a value while allowing memory-only operation after a backend failure. */
  remove = (key: StorageKey) => this.#run({ fn: (s) => s.remove(key), fallback: undefined })

  /** Loads matching chunks, returning none if persistence is unavailable. */
  loadRange = (prefix: StorageKey) =>
    this.#run<Chunk[]>({ fn: (s) => s.loadRange(prefix), fallback: [] })

  /** Removes matching chunks while tolerating backend failure. */
  removeRange = (prefix: StorageKey) =>
    this.#run({ fn: (s) => s.removeRange(prefix), fallback: undefined })

  #run = async <T>({
    fn,
    fallback,
  }: {
    readonly fn: (s: StorageAdapterInterface) => Promise<T>
    readonly fallback: T
  }): Promise<T> => {
    if (this.#inner === undefined) return fallback
    try {
      return await fn(this.#inner)
    } catch (error) {
      this.#inner = undefined
      this.#failure = error
      this.#onDisable(error)
      return fallback
    }
  }
}
