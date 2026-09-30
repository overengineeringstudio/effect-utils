/** Typecheck-only regression: declared failures survive heterogeneous endpoint registration. */
import { Effect, Schema } from 'effect'

import { serve, type AnyImplementation, type AppROf } from '../endpoint/Endpoint.ts'
import {
  type ErrorOf,
  type ObjectErrorOf,
  type ObjectHandlerSpecMap,
  type ObjectImpl,
  RestateObject,
  RestateService,
  RestateWorkflow,
  type WorkflowRunErrorOf,
} from './Service.ts'

/* eslint-disable @typescript-eslint/no-unused-vars -- type-level assertions */
type Assert<T extends true> = T
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type HandlerError<THandler extends (...args: never[]) => unknown> = Effect.Error<ReturnType<THandler>>

class Rejected extends Schema.TaggedError<Rejected>()('Rejected', { reason: Schema.String }) {}
const declared = { input: Schema.Void, success: Schema.Void, error: Rejected }
const infallible = { input: Schema.Void, success: Schema.Void }
const reject = () => Effect.fail(new Rejected({ reason: 'denied' }))

const service = RestateService.contract({
  name: 'declared-error-service',
  handlers: { reject: declared, accept: infallible },
})
const serviceLive = RestateService.implement<typeof service>({
  contractValue: service,
  impl: { reject, accept: () => Effect.void },
})
const object = RestateObject.contract({
  name: 'declared-error-object',
  def: {
    state: {},
    handlers: { reject: declared, query: { ...declared, shared: true }, accept: infallible },
  },
})
const objectLive = RestateObject.implement<typeof object>({
  contractValue: object,
  impl: { reject, query: reject, accept: () => Effect.void },
})
const workflow = RestateWorkflow.contract({
  name: 'declared-error-workflow',
  def: { state: {}, payload: declared, signals: { reject: declared }, queries: { accept: infallible } },
})
const workflowLive = RestateWorkflow.implement<typeof workflow>({
  contractValue: workflow,
  impl: { run: reject, reject, accept: () => Effect.void },
})

/* Concrete contracts still enforce their exact declared error, or no error. */
type _ServiceError = Assert<Equals<ErrorOf<typeof service, 'reject'>, Rejected>>
type _ServiceNoError = Assert<Equals<ErrorOf<typeof service, 'accept'>, never>>
type _ObjectError = Assert<Equals<ObjectErrorOf<typeof object, 'query'>, Rejected>>
type _ObjectNoError = Assert<Equals<ObjectErrorOf<typeof object, 'accept'>, never>>
type _WorkflowError = Assert<Equals<WorkflowRunErrorOf<typeof workflow>, Rejected>>
const workflowQuery = workflowLive.impl.accept(undefined)
type _WorkflowQueryNoError = Assert<Equals<Effect.Error<typeof workflowQuery>, never>>

/* Erasing the handler map at the endpoint must not narrow declared errors to never. */
const implementations = [
  serviceLive,
  objectLive,
  workflowLive,
] satisfies readonly AnyImplementation<never>[]
type _NoAppRequirements = Assert<Equals<AppROf<typeof implementations>, never>>
const endpoint = serve({ services: implementations, port: 0 })
type _EndpointRequirements = Assert<Equals<Effect.Services<typeof endpoint>, never>>
type _ErasedErrorAllowsDeclaredFailures = Assert<
  Rejected extends HandlerError<ObjectImpl<ObjectHandlerSpecMap, never>[string]> ? true : false
>
