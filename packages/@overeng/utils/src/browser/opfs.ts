/**
 * Origin Private File System (OPFS) utilities with Effect integration.
 * Provides type-safe access to the browser's private file system.
 */

import { Effect, Option, Schema } from 'effect'

import { prettyBytes } from './pretty-bytes.ts'

// Augment FileSystemDirectoryHandle with async iterator methods not yet in TS DOM lib
declare global {
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemHandle>
    keys(): AsyncIterableIterator<string>
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>
  }
}

/**
 * Error thrown when OPFS is not supported in the current environment.
 */
export class OPFSNotSupportedError extends Schema.TaggedError<OPFSNotSupportedError>()(
  'OPFSNotSupportedError',
  {
    message: Schema.String,
  },
) {
  static readonly notAvailable = new OPFSNotSupportedError({
    message: 'OPFS is not available: navigator.storage.getDirectory is not supported',
  })
}

/**
 * Error thrown when an OPFS operation fails.
 */
export class OPFSError extends Schema.TaggedError<OPFSError>()('OPFSError', {
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Checks if OPFS is supported in the current environment.
 * Verifies both navigator.storage and the getDirectory method exist.
 * Note: Some browsers (Safari, Firefox) expose navigator.storage but not getDirectory.
 */
export const isOPFSSupported = (): boolean =>
  typeof navigator !== 'undefined' &&
  navigator.storage !== undefined &&
  typeof navigator.storage.getDirectory === 'function'

/**
 * Gets the OPFS root directory handle.
 * Fails with OPFSNotSupportedError if OPFS is not available.
 */
export const getRootHandle: Effect.Effect<FileSystemDirectoryHandle, OPFSNotSupportedError> =
  Effect.suspend(() => {
    if (!isOPFSSupported()) {
      return Effect.fail(OPFSNotSupportedError.notAvailable)
    }
    return Effect.tryPromise({
      try: () => navigator.storage.getDirectory(),
      catch: () => OPFSNotSupportedError.notAvailable,
    })
  })

/**
 * Gets a directory handle for the given absolute path.
 * Creates intermediate directories if they don't exist when `create` is true.
 *
 * @param absDirPath - Absolute path to the directory (e.g., "/foo/bar/baz")
 * @param options - Options for directory creation
 */
// oxlint-disable-next-line overeng/named-args -- mirrors Web File API pattern
export const getDirHandle = (
  absDirPath: string | undefined,
  options?: { create?: boolean },
): Effect.Effect<FileSystemDirectoryHandle, OPFSNotSupportedError | OPFSError> =>
  Effect.gen(function* () {
    const rootHandle = yield* getRootHandle

    if (absDirPath === undefined || absDirPath === '' || absDirPath === '/') {
      return rootHandle
    }

    const segments = absDirPath.split('/').filter(Boolean)
    let currentHandle = rootHandle

    for (const segment of segments) {
      currentHandle = yield* Effect.tryPromise({
        try: () => currentHandle.getDirectoryHandle(segment, { create: options?.create ?? false }),
        catch: (error) =>
          new OPFSError({
            operation: 'getDirectoryHandle',
            path: absDirPath,
            cause: error,
          }),
      })
    }

    return currentHandle
  })

/**
 * Gets a file handle for the given path within a directory.
 *
 * @param dirHandle - The directory handle to search in
 * @param fileName - The name of the file
 * @param options - Options for file creation
 */
// oxlint-disable-next-line overeng/named-args -- mirrors Web File API pattern
export const getFileHandle = (
  dirHandle: FileSystemDirectoryHandle,
  fileName: string,
  options?: { create?: boolean },
): Effect.Effect<FileSystemFileHandle, OPFSError> =>
  Effect.tryPromise({
    try: () => dirHandle.getFileHandle(fileName, { create: options?.create ?? false }),
    catch: (error) =>
      new OPFSError({
        operation: 'getFileHandle',
        path: fileName,
        cause: error,
      }),
  })

/**
 * Information about a file system entry.
 */
export type EntryInfo = {
  readonly name: string
  readonly kind: 'file' | 'directory'
  readonly size?: number
}

/**
 * Lists all entries in a directory.
 *
 * @param dirHandle - The directory handle to list
 */
export const listEntries = (
  dirHandle: FileSystemDirectoryHandle,
): Effect.Effect<readonly EntryInfo[], OPFSError> =>
  Effect.gen(function* () {
    const entries: EntryInfo[] = []

    yield* Effect.tryPromise({
      try: async () => {
        for await (const entry of dirHandle.values()) {
          if (entry.kind === 'file') {
            const fileHandle = entry as FileSystemFileHandle
            const file = await fileHandle.getFile()
            entries.push({ name: entry.name, kind: 'file', size: file.size })
          } else {
            entries.push({ name: entry.name, kind: 'directory' })
          }
        }
      },
      catch: (error) =>
        new OPFSError({
          operation: 'listEntries',
          cause: error,
        }),
    })

    return entries
  })

/**
 * Result of printing a directory tree.
 */
export type TreeLine = {
  readonly prefix: string
  readonly icon: '📁' | '📄'
  readonly name: string
  readonly size?: string
}

/**
 * Generates a tree representation of the directory structure.
 * Returns an array of lines that can be printed or processed.
 *
 * @param dirHandle - The directory handle to traverse (defaults to root)
 * @param options - Options for tree generation
 */
// oxlint-disable-next-line overeng/named-args -- mirrors Web File API pattern
export const getTree = (
  dirHandle?: FileSystemDirectoryHandle,
  options?: { depth?: number; prefix?: string },
): Effect.Effect<readonly TreeLine[], OPFSNotSupportedError | OPFSError> =>
  Effect.gen(function* () {
    const depth = options?.depth ?? Number.POSITIVE_INFINITY
    const prefix = options?.prefix ?? ''

    if (depth < 0) {
      return []
    }

    const handle = dirHandle === undefined ? yield* getRootHandle : dirHandle

    const lines: TreeLine[] = []

    // Collect entries first
    const entries: Array<{ name: string; kind: 'file' | 'directory'; size?: number }> = []
    yield* Effect.tryPromise({
      try: async () => {
        for await (const entry of handle.values()) {
          if (entry.kind === 'file') {
            const fileHandle = entry as FileSystemFileHandle
            const file = await fileHandle.getFile()
            entries.push({ name: entry.name, kind: 'file', size: file.size })
          } else {
            entries.push({ name: entry.name, kind: 'directory' })
          }
        }
      },
      catch: (error) =>
        new OPFSError({
          operation: 'getTree',
          cause: error,
        }),
    })

    // Process entries and recurse for directories
    for (const entry of entries) {
      const isDirectory = entry.kind === 'directory'

      lines.push({
        prefix,
        icon: isDirectory ? '📁' : '📄',
        name: entry.name,
        ...(entry.size !== undefined ? { size: prettyBytes(entry.size) } : {}),
      })

      if (isDirectory && depth > 0) {
        const nestedHandle = yield* Effect.tryPromise({
          try: () => handle.getDirectoryHandle(entry.name),
          catch: (error) =>
            new OPFSError({
              operation: 'getTree',
              path: entry.name,
              cause: error,
            }),
        })
        const nestedLines = yield* getTree(nestedHandle, {
          depth: depth - 1,
          prefix: `${prefix}  `,
        })
        lines.push(...nestedLines)
      }
    }

    return lines
  })

/**
 * Prints a tree representation of the directory structure to the console.
 *
 * @param dirHandle - The directory handle to traverse (defaults to root)
 * @param options - Options for tree generation
 */
// oxlint-disable-next-line overeng/named-args -- mirrors Web File API pattern
export const printTree = (
  dirHandle?: FileSystemDirectoryHandle,
  options?: { depth?: number },
): Effect.Effect<void, OPFSNotSupportedError | OPFSError> =>
  Effect.gen(function* () {
    const lines = yield* getTree(dirHandle, options)
    for (const line of lines) {
      const sizeStr = line.size ? ` (${line.size})` : ''
      console.log(`${line.prefix}${line.icon} ${line.name}${sizeStr}`)
    }
  })

/**
 * Deletes all entries in a directory recursively.
 *
 * @param dirHandle - The directory handle to clear
 */
export const deleteAll = (dirHandle: FileSystemDirectoryHandle): Effect.Effect<void, OPFSError> =>
  Effect.tryPromise({
    try: async () => {
      for await (const entryName of dirHandle.keys()) {
        await dirHandle.removeEntry(entryName, { recursive: true })
      }
    },
    catch: (error) =>
      new OPFSError({
        operation: 'deleteAll',
        cause: error,
      }),
  })

/**
 * Deletes a specific entry from a directory.
 *
 * @param dirHandle - The directory containing the entry
 * @param name - The name of the entry to delete
 * @param options - Options for deletion
 */
// oxlint-disable-next-line overeng/named-args -- mirrors Web File API pattern
export const deleteEntry = (
  dirHandle: FileSystemDirectoryHandle,
  name: string,
  options?: { recursive?: boolean },
): Effect.Effect<void, OPFSError> =>
  Effect.tryPromise({
    try: () => dirHandle.removeEntry(name, { recursive: options?.recursive ?? false }),
    catch: (error) =>
      new OPFSError({
        operation: 'deleteEntry',
        path: name,
        cause: error,
      }),
  })

/**
 * Reads the contents of a file as text.
 *
 * @param fileHandle - The file handle to read
 */
export const readFileText = (fileHandle: FileSystemFileHandle): Effect.Effect<string, OPFSError> =>
  Effect.tryPromise({
    try: async () => {
      const file = await fileHandle.getFile()
      return file.text()
    },
    catch: (error) =>
      new OPFSError({
        operation: 'readFileText',
        cause: error,
      }),
  })

/**
 * Reads the contents of a file as an ArrayBuffer.
 *
 * @param fileHandle - The file handle to read
 */
export const readFileBuffer = (
  fileHandle: FileSystemFileHandle,
): Effect.Effect<ArrayBuffer, OPFSError> =>
  Effect.tryPromise({
    try: async () => {
      const file = await fileHandle.getFile()
      return file.arrayBuffer()
    },
    catch: (error) =>
      new OPFSError({
        operation: 'readFileBuffer',
        cause: error,
      }),
  })

/**
 * Writes text content to a file.
 *
 * @param fileHandle - The file handle to write to
 * @param content - The text content to write
 */
// oxlint-disable-next-line overeng/named-args -- mirrors Web File API pattern
export const writeFileText = (
  fileHandle: FileSystemFileHandle,
  content: string,
): Effect.Effect<void, OPFSError> =>
  Effect.tryPromise({
    try: async () => {
      const writable = await fileHandle.createWritable()
      await writable.write(content)
      await writable.close()
    },
    catch: (error) =>
      new OPFSError({
        operation: 'writeFileText',
        cause: error,
      }),
  })

/**
 * Writes binary content to a file.
 *
 * @param fileHandle - The file handle to write to
 * @param content - The binary content to write
 */
// oxlint-disable-next-line overeng/named-args -- mirrors Web File API pattern
export const writeFileBuffer = (
  fileHandle: FileSystemFileHandle,
  content: BufferSource,
): Effect.Effect<void, OPFSError> =>
  Effect.tryPromise({
    try: async () => {
      const writable = await fileHandle.createWritable()
      await writable.write(content)
      await writable.close()
    },
    catch: (error) =>
      new OPFSError({
        operation: 'writeFileBuffer',
        cause: error,
      }),
  })

// Re-export Option for convenience when working with optional fields
export { Option }
