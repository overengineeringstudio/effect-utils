import { CString, dlopen, read, toArrayBuffer } from 'bun:ffi'

// Loaded only on Linux/Bun by the process scanner. Node's/Bun's fs Dir can
// materialize and close the underlying fd eagerly, so it cannot prove self-fds.
const native =
  process.platform === 'linux'
    ? dlopen('libc.so.6', {
        opendir: { args: ['ptr'], returns: 'ptr' },
        readdir: { args: ['ptr'], returns: 'ptr' },
        closedir: { args: ['ptr'], returns: 'i32' },
        // eslint-disable-next-line no-underscore-dangle -- Native ABI name.
        __errno_location: { args: [], returns: 'ptr' },
      })
    : undefined

/** Visit names with the actual Linux directory descriptor open throughout. */
export const visitEditorViewProcessDescriptors = ({
  path,
  visit,
}: {
  readonly path: string
  readonly visit: (name: string) => void
}): void => {
  if (
    native === undefined ||
    process.platform !== 'linux' ||
    (process.arch !== 'x64' && process.arch !== 'arm64')
  )
    throw new Error('unsupported native process-directory ABI')
  // eslint-disable-next-line no-underscore-dangle -- Native ABI name.
  const errno = native.symbols.__errno_location()
  if (errno === null) throw new Error('process-directory errno unavailable')
  const errnoView = new DataView(toArrayBuffer(errno, 0, 4))
  const directory = native.symbols.opendir(Buffer.from(`${path}\0`))
  if (directory === null) throw new Error(`opendir: ${path}: errno ${read.i32(errno)}`)
  let closeError = 0
  try {
    for (;;) {
      // readdir's null result means EOF only when errno remains zero.
      errnoView.setInt32(0, 0, true)
      const entry = native.symbols.readdir(directory)
      if (entry === null) {
        const code = read.i32(errno)
        if (code !== 0) throw new Error(`readdir: ${path}: errno ${code}`)
        break
      }
      // Linux x86_64/aarch64 dirent: ino64, off64, reclen16, type8, name.
      const name = new CString(entry, 19).toString()
      if (name !== '.' && name !== '..') visit(name)
    }
  } finally {
    closeError = native.symbols.closedir(directory)
  }
  if (closeError !== 0) throw new Error(`closedir: ${path}: errno ${read.i32(errno)}`)
}
