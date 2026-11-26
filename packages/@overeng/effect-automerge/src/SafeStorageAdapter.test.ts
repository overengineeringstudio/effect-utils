import type { StorageAdapterInterface } from '@automerge/automerge-repo'
import { describe, expect, it } from 'vitest'

import { SafeStorageAdapter } from './SafeStorageAdapter.ts'

describe('SafeStorageAdapter', () => {
  it('reports a backend failure once and stops using the failed backend', async () => {
    const failure = new Error('quota exceeded')
    const reported: unknown[] = []
    let calls = 0
    const fail = async (): Promise<never> => {
      calls++
      throw failure
    }
    const backend: StorageAdapterInterface = {
      load: fail,
      save: fail,
      remove: fail,
      loadRange: fail,
      removeRange: fail,
    }
    const storage = new SafeStorageAdapter(
      () => backend,
      (error) => reported.push(error),
    )
    expect(storage.persistent).toBe(true)
    expect(await storage.load(['document'])).toBeUndefined()
    expect(storage.persistent).toBe(false)
    await storage.save(['document'], new Uint8Array([1]))
    await storage.remove(['document'])
    expect(await storage.loadRange([])).toEqual([])
    await storage.removeRange([])
    expect(calls).toBe(1)
    expect(reported).toEqual([failure])
  })

  it('surfaces construction failure without preventing memory-only play', async () => {
    const failure = new Error('IndexedDB unavailable')
    const reported: unknown[] = []
    const storage = new SafeStorageAdapter(
      () => {
        throw failure
      },
      (error) => reported.push(error),
    )
    expect(storage.persistent).toBe(false)
    expect(await storage.loadRange([])).toEqual([])
    expect(reported).toEqual([failure])
  })
})
