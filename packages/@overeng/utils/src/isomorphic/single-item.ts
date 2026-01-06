export class SingleItem<T> {
  public item: T

  constructor(item: T) {
    this.item = item
  }

  map = <U>(fn: (item: T) => U): SingleItem<U> => new SingleItem(fn(this.item))

  filter = (fn: (item: T) => boolean): SingleItem<T | undefined> =>
    fn(this.item) ? this : new SingleItem(undefined)
}

export const singleItem = <T>(item: T) => new SingleItem(item)
