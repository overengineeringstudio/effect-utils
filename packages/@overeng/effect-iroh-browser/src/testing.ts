import type { FramedConn } from './Connection.ts'

/** In-memory `FramedConn`: what one side sends, the other receives. Test helper. */
export class FakeConn implements FramedConn {
  closed = false
  sent: Uint8Array[] = []
  other!: FakeConn
  #inbox: Array<Uint8Array | null> = []
  #waiters: Array<(data: Uint8Array | null) => void> = []

  readonly remote: string
  constructor(remote: string) {
    this.remote = remote
  }

  remoteId() {
    return this.remote
  }

  async send(data: Uint8Array) {
    if (this.closed) throw new Error('closed')
    this.sent.push(data)
    this.other.#deliver(data)
  }

  recv(): Promise<Uint8Array | null> {
    const next = this.#inbox.shift()
    if (next !== undefined) return Promise.resolve(next)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.#deliver(null)
    this.other.#deliver(null)
  }

  #deliver(data: Uint8Array | null) {
    const waiter = this.#waiters.shift()
    if (waiter) waiter(data)
    else this.#inbox.push(data)
  }
}

/** A connection between endpoints `a` and `b`: `[a's end, b's end]`. */
export const connPair = ({ a, b }: { a: string; b: string }): [FakeConn, FakeConn] => {
  const atA = new FakeConn(b)
  const atB = new FakeConn(a)
  atA.other = atB
  atB.other = atA
  return [atA, atB]
}
