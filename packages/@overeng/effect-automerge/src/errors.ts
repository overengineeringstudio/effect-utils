import { Data } from 'effect'

/** The id is neither a valid document id nor an automerge URL. */
export class InvalidDocumentId extends Data.TaggedError('InvalidDocumentId')<{
  readonly documentId: string
  readonly message: string
}> {
  constructor(documentId: string) {
    super({ documentId, message: `invalid document id ${documentId}` })
  }
}

/**
 * Neither local storage nor any connected peer has the document (right now). Peers may
 * connect later, so this is usually worth retrying (see `AutomergeRepo.findWithRetry`).
 */
export class DocUnavailable extends Data.TaggedError('DocUnavailable')<{
  readonly documentId: string
  readonly message: string
}> {
  constructor(documentId: string) {
    super({ documentId, message: `document ${documentId} is unavailable` })
  }
}

/** The document was deleted from this repo. */
export class DocDeleted extends Data.TaggedError('DocDeleted')<{
  readonly documentId: string
  readonly message: string
}> {
  constructor(documentId: string) {
    super({ documentId, message: `document ${documentId} was deleted` })
  }
}

export type FindError = InvalidDocumentId | DocUnavailable | DocDeleted

/** A save cannot be acknowledged, or Repo lifecycle persistence failed. */
export class RepoPersistenceError extends Data.TaggedError('RepoPersistenceError')<{
  readonly operation: 'save' | 'flush' | 'shutdown'
  readonly cause: unknown
}> {}
