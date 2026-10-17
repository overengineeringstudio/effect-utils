import type { RpcDescriptor } from './descriptor.ts'

/** One revisioned view of the application descriptors an explorer currently resolves. */
export interface DescriptorSetSnapshot {
  /** Increases whenever the effective descriptor set changes; starts at 0. */
  readonly revision: number
  readonly descriptors: ReadonlyArray<RpcDescriptor>
}

/** Read side of an application descriptor set consumed by the inspector group. */
export interface DescriptorSet {
  readonly current: () => DescriptorSetSnapshot
  /** Calls `listener` synchronously after each revision change; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void
}

/** Named input for one owner's runtime descriptor registration. */
export interface DescriptorRegistration {
  readonly owner: string
  readonly descriptors: ReadonlyArray<RpcDescriptor>
}

/** Descriptor set whose runtime part is owned by registrations released by their holders. */
export interface MutableDescriptorSet extends DescriptorSet {
  readonly descriptorForTag: (tag: string) => RpcDescriptor | undefined
  /**
   * Registers or replaces the owner's descriptors and returns its release. Releasing a
   * registration that a later registration of the same owner already replaced is a no-op.
   */
  readonly register: (registration: DescriptorRegistration) => () => void
}

/** Fixed descriptor set for hosts and tests without runtime registration. */
export const staticDescriptorSet = (descriptors: ReadonlyArray<RpcDescriptor>): DescriptorSet => {
  const snapshot: DescriptorSetSnapshot = { revision: 0, descriptors }
  return { current: () => snapshot, subscribe: () => () => undefined }
}

const sameDescriptors = ({
  left,
  right,
}: {
  readonly left: ReadonlyMap<string, RpcDescriptor>
  readonly right: ReadonlyMap<string, RpcDescriptor>
}): boolean => {
  if (left.size !== right.size) return false
  const rightEntries = [...right]
  let index = 0
  for (const [tag, descriptor] of left) {
    const entry = rightEntries[index]
    if (entry === undefined || entry[0] !== tag || entry[1] !== descriptor) return false
    index += 1
  }
  return true
}

/**
 * Builds a descriptor set from permanent construction-time descriptors plus runtime
 * registrations keyed by owner. Construction-time descriptors always win their tag. Among
 * registrations, a tag stays resolvable while any live registration holds it, and the most
 * recently (re)registered holder supplies its descriptor.
 */
export const makeDescriptorSet = (base: ReadonlyArray<RpcDescriptor>): MutableDescriptorSet => {
  const baseByTag = new Map(base.map((descriptor) => [descriptor.tag, descriptor] as const))
  /** Insertion order is registration recency: re-registering an owner moves it last. */
  const registrations = new Map<string, DescriptorRegistration>()
  const listeners = new Set<() => void>()
  let effective: ReadonlyMap<string, RpcDescriptor> = baseByTag
  let snapshot: DescriptorSetSnapshot = { revision: 0, descriptors: [...baseByTag.values()] }

  const recompute = (): void => {
    const next = new Map(baseByTag)
    for (const registration of registrations.values()) {
      for (const descriptor of registration.descriptors) {
        if (baseByTag.has(descriptor.tag) === true) continue
        next.set(descriptor.tag, descriptor)
      }
    }
    if (sameDescriptors({ left: effective, right: next }) === true) return
    effective = next
    snapshot = { revision: snapshot.revision + 1, descriptors: [...next.values()] }
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* A failing inspector listener cannot interrupt host mount or unmount. */
      }
    }
  }

  return {
    current: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    descriptorForTag: (tag) => effective.get(tag),
    register: ({ owner, descriptors }) => {
      const registration: DescriptorRegistration = { owner, descriptors: [...descriptors] }
      registrations.delete(owner)
      registrations.set(owner, registration)
      recompute()
      return () => {
        if (registrations.get(owner) !== registration) return
        registrations.delete(owner)
        recompute()
      }
    },
  }
}
