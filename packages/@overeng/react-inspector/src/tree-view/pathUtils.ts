export const DEFAULT_ROOT_PATH = '$'

const WILDCARD = '*'

type DataIterator = (data: unknown) => Generator<{ name: string; data: unknown }>

export function hasChildNodes(data: unknown, dataIterator: DataIterator): boolean {
  return dataIterator(data).next().done === false
}

export const wildcardPathsFromLevel = (level: number): string[] => {
  // i is depth
  return Array.from({ length: level }, (_, i) =>
    [DEFAULT_ROOT_PATH].concat(Array.from({ length: i }, () => '*')).join('.'),
  )
}

export const getExpandedPaths = (
  data: unknown,
  dataIterator: DataIterator,
  expandPaths: string[] | undefined,
  expandLevel: number,
  prevExpandedPaths: Record<string, boolean>,
): Record<string, boolean> => {
  const wildcardPaths = wildcardPathsFromLevel(expandLevel)
    .concat(expandPaths ?? [])
    .filter((path): path is string => typeof path === 'string') // could be undefined

  const expandedPaths: string[] = []
  wildcardPaths.forEach((wildcardPath) => {
    const keyPaths = wildcardPath.split('.')
    const populatePaths = (curData: unknown, curPath: string, depth: number) => {
      if (depth === keyPaths.length) {
        expandedPaths.push(curPath)
        return
      }
      const key = keyPaths[depth]
      if (key === undefined) return
      if (depth === 0) {
        if (
          hasChildNodes(curData, dataIterator) === true &&
          (key === DEFAULT_ROOT_PATH || key === WILDCARD)
        ) {
          populatePaths(curData, DEFAULT_ROOT_PATH, depth + 1)
        }
      } else {
        if (key === WILDCARD) {
          for (const { name, data } of dataIterator(curData)) {
            if (hasChildNodes(data, dataIterator) === true) {
              populatePaths(data, `${curPath}.${name}`, depth + 1)
            }
          }
        } else {
          const value = (curData as Record<string, unknown>)[key]
          if (hasChildNodes(value, dataIterator) === true) {
            populatePaths(value, `${curPath}.${key}`, depth + 1)
          }
        }
      }
    }

    populatePaths(data, '', 0)
  })

  return expandedPaths.reduce(
    (obj, path) => {
      obj[path] = true
      return obj
    },
    { ...prevExpandedPaths },
  )
}
