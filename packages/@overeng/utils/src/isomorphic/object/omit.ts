/** Returns a shallowly cloned object with the provided keys omitted */
export const omit = <Obj extends Record<string, any>, Keys extends keyof Obj>(
  obj: Obj,
  keys: Keys[],
): Omit<Obj, Keys> => {
  return Object.keys(obj).reduce((acc, key: any) => {
    if (!keys.includes(key)) {
      acc[key] = (obj as any)[key]
    }
    return acc
  }, {} as any)
}
