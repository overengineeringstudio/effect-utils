/**
 * Collision-resistant UID generator for browsers.
 * Sequential for fast db lookups and recency sorting.
 * Safe for element IDs and server-side lookups.
 *
 * Based on cuid.js by Eric Elliott (MIT License)
 */

export type Cuid = string

const lim = 2 ** 32 - 1

const getRandomValue = () => {
  const values = crypto.getRandomValues(new Uint32Array(1))
  const value = values[0] ?? 0
  return Math.abs(value / lim)
}

const pad = (num: number | string, size: number) => {
  const s = `000000000${num}`
  return s.slice(s.length - size)
}

const globalCount = Object.keys(globalThis).length
const clientId = pad(navigator.userAgent.length.toString(36) + globalCount.toString(36), 4)

const fingerprint = () => clientId

let c = 0
const blockSize = 4
const base = 36
const discreteValues = base ** blockSize

const randomBlock = () => {
  return pad(Math.trunc(getRandomValue() * discreteValues).toString(base), blockSize)
}

const safeCounter = () => {
  c = c < discreteValues ? c : 0
  c++
  return c - 1
}

/** Generate a collision-resistant unique identifier */
export const cuid = (): Cuid => {
  const letter = 'c'
  const timestamp = Date.now().toString(base)
  const counter = pad(safeCounter().toString(base), blockSize)
  const print = fingerprint()
  const random = randomBlock() + randomBlock()

  return letter + timestamp + counter + print + random
}

/** Generate a shorter slug-style identifier */
export const slug = () => {
  const date = Date.now().toString(36)
  const counter = safeCounter().toString(36).slice(-4)
  const print = fingerprint().slice(0, 1) + fingerprint().slice(-1)
  const random = randomBlock().slice(-2)

  return date.slice(-2) + counter + print + random
}

/** Check if a string is a valid cuid */
export const isCuid = (stringToCheck: string) => {
  if (typeof stringToCheck !== 'string') return false
  if (stringToCheck.startsWith('c')) return true
  return false
}

/** Check if a string is a valid slug */
export const isSlug = (stringToCheck: string) => {
  if (typeof stringToCheck !== 'string') return false
  const stringLength = stringToCheck.length
  if (stringLength >= 7 && stringLength <= 10) return true
  return false
}
