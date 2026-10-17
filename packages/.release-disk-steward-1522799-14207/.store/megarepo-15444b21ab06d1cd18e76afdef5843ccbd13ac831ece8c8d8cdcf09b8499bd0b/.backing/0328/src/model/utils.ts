/** Iterate over an array in reverse order */
export function* reverseIterate<T>(array: T[]): Generator<T, void, void> {
  for (let i = array.length - 1; i >= 0; i--) {
    yield array[i]!
  }
}
