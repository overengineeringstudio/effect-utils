declare module 'bun:sqlite' {
  /** Bun's readonly SQLite database used by the OpenCode adapter at runtime. */
  export class Database {
    constructor(
      path: string,
      options: {
        readonly: boolean
      },
    )
    query(sql: string): {
      get(...params: ReadonlyArray<string | number | bigint | Uint8Array | null>): unknown
      all(
        ...params: ReadonlyArray<string | number | bigint | Uint8Array | null>
      ): ReadonlyArray<unknown>
    }
    close(): void
  }
}
