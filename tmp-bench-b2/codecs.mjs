import { parse as losslessParse, stringify as losslessStringify, LosslessNumber } from 'lossless-json'
import contract from './contract.generated.json' with {type: 'json'}
export const fields = contract.fields
export const bounds = Object.fromEntries(Object.entries(contract.integers).map(([kind, {bits, signed}]) => [kind, signed ? [-(1n << BigInt(bits - 1)), (1n << BigInt(bits - 1)) - 1n] : [0n, (1n << BigInt(bits)) - 1n]]))
export const integer = (value, kind = 'u64') => {
  if (typeof value !== 'bigint') throw new TypeError('expected bigint')
  const [min, max] = bounds[kind]
  if (value < min || value > max) throw new RangeError(kind)
  return value
}
export const decimal = (text, kind = 'u64') => {
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*|-[1-9][0-9]*)$/.test(text)) throw new TypeError('noncanonical integer')
  return integer(BigInt(text), kind)
}
const map = (rows, convert) => {
  if (!Array.isArray(rows)) throw new TypeError('expected array')
  return rows.map(row => Object.fromEntries(fields.map(key => [key, convert(row[key], key)])))
}
export const candidates = {
  a: {
    decode: text => map(JSON.parse(text), value => decimal(value)),
    encode: rows => JSON.stringify(map(rows, value => integer(value).toString())),
    scalarDecode: (token, kind) => decimal(JSON.parse(token), kind),
    scalarEncode: (value, kind) => JSON.stringify(integer(value, kind).toString())
  },
  b: {
    decode: text => map(JSON.parse(text, (key, value, context) => fields.includes(key) ? decimal(context.source) : value), value => integer(value)),
    encode: rows => JSON.stringify(map(rows, value => JSON.rawJSON(integer(value).toString()))),
    scalarDecode: (token, kind) => JSON.parse(token, (key, value, context) => key === '' ? decimal(context.source, kind) : value),
    scalarEncode: (value, kind) => JSON.stringify(JSON.rawJSON(integer(value, kind).toString()))
  },
  c: {
    decode: text => map(losslessParse(text), value => decimal(value?.value)),
    encode: rows => losslessStringify(map(rows, value => new LosslessNumber(integer(value).toString()))),
    scalarDecode: (token, kind) => decimal(losslessParse(token)?.value, kind),
    scalarEncode: (value, kind) => losslessStringify(new LosslessNumber(integer(value, kind).toString()))
  },
  d: {
    decode: bytes => {
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) throw new TypeError('binary frame')
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const count = view.getUint32(0, true)
      if (bytes.byteLength !== 4 + count * fields.length * 8) throw new RangeError('binary length')
      let offset = 4
      return Array.from({length: count}, () => Object.fromEntries(fields.map(key => {
        const value = view.getBigUint64(offset, true); offset += 8; return [key, value]
      })))
    },
    encode: rows => {
      const bytes = new Uint8Array(4 + rows.length * fields.length * 8)
      const view = new DataView(bytes.buffer); view.setUint32(0, rows.length, true)
      let offset = 4
      for (const row of rows) for (const key of fields) { view.setBigUint64(offset, integer(row[key]), true); offset += 8 }
      return bytes
    },
    scalarDecode: (bytes, kind) => {
      if (!(bytes instanceof Uint8Array) || bytes.length !== 8) throw new RangeError('scalar width')
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      return kind === 'u64' ? view.getBigUint64(0, true) : view.getBigInt64(0, true)
    },
    scalarEncode: (value, kind) => {
      integer(value, kind)
      const bytes = new Uint8Array(8); const view = new DataView(bytes.buffer)
      if (kind === 'u64') view.setBigUint64(0, value, true); else view.setBigInt64(0, value, true)
      return bytes
    }
  },
  e: {
    decode: text => map(JSON.parse(text), (value, key) => key === 'a' ? decimal(value) : (Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : (() => {throw new RangeError('unsafe unannotated integer')})())),
    encode: rows => JSON.stringify(map(rows, (value, key) => key === 'a' ? integer(value).toString() : Number(integer(value)))),
    scalarDecode: (token, kind) => {const value = JSON.parse(token); if (!Number.isSafeInteger(value)) throw new RangeError('unsafe unannotated'); return integer(BigInt(value), kind)},
    scalarEncode: (value, kind) => JSON.stringify(Number(integer(value, kind)))
  }
}
export const support = () => {
  let source
  JSON.parse('9007199254740993', (_key, _value, context) => {source = context?.source})
  return {source: source === '9007199254740993', rawJSON: typeof JSON.rawJSON === 'function', bigUint64Array: typeof BigUint64Array === 'function'}
}
