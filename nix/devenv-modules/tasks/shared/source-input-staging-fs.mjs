import * as Fs from 'node:fs/promises'
import * as Path from 'node:path'

const makeDirectoriesWritable = async (root, fs) => {
  const { mode } = await fs.stat(root)
  await fs.chmod(root, mode | 0o200)
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeDirectoriesWritable(Path.join(root, entry.name), fs)
  }
}

/** Removes an immutable staging tree after restoring only directory owner-write bits. */
export const removeStagingTree = async (root, fs = Fs) => {
  try {
    await makeDirectoriesWritable(root, fs)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await fs.rm(root, { force: true, recursive: true })
}
