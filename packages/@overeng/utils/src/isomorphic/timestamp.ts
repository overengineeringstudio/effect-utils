import { Brand, Schema } from 'effect'

/** Unix timestamp integer in milliseconds since epoch */
export type Timestamp = Brand.Branded<number, 'Timestamp'>

export const timestamp = (value: number | string | Date): Timestamp => {
  if (typeof value === 'number') {
    return Math.round(value) as Timestamp
  } else if (value instanceof Date) {
    return Math.round(value.getTime()) as Timestamp
  } else {
    return Math.round(new Date(value).getTime()) as Timestamp
  }
}

export const timestampSchema = Schema.transform(
  Schema.fromBrand(Brand.nominal<Timestamp>())(Schema.Number),
  Schema.Number,
  { decode: (_) => _, encode: timestamp },
)

export const timestampNow = (): Timestamp => Math.round(Date.now()) as Timestamp
