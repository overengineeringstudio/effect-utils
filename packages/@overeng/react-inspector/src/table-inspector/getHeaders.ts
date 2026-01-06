export function getHeaders(
  data: unknown,
): { rowHeaders: (string | number)[]; colHeaders: string[] } | undefined {
  if (typeof data === 'object' && data !== null) {
    let rowHeaders: (string | number)[] = []
    // is an array
    if (Array.isArray(data)) {
      const nRows = data.length
      rowHeaders = [...Array(nRows).keys()]
    } else {
      // is an object
      // keys are row indexes
      rowHeaders = Object.keys(data)
    }

    // Time: O(nRows * nCols)
    const colHeaders = rowHeaders.reduce<string[]>((colHeaders, rowHeader) => {
      const row = (data as Record<string | number, unknown>)[rowHeader]
      if (typeof row === 'object' && row !== null) {
        /* O(nCols) Could optimize `includes` here */
        const cols = Object.keys(row)
        cols.reduce<string[]>((xs, x) => {
          if (!xs.includes(x)) {
            /* xs is the colHeaders to be filled by searching the row's indexes */
            xs.push(x)
          }
          return xs
        }, colHeaders)
      }
      return colHeaders
    }, [])
    return {
      rowHeaders: rowHeaders,
      colHeaders: colHeaders,
    }
  }
  return undefined
}
