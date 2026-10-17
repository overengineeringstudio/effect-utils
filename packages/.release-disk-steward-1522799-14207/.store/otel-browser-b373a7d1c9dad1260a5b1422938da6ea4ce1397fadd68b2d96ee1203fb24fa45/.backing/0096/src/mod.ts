/** Injectable browser capabilities and scoped native adapters. */
export * as BrowserPlatform from './BrowserPlatform.ts'
/** Page-owned OTLP resource identity. */
export * as BrowserResource from './BrowserResource.ts'
/** Page-scoped tracer, metrics, and export lifecycle. */
export * as BrowserTelemetry from './BrowserTelemetry.ts'
/** Interaction spans and latency observations. */
export * as Interactions from './ui/Interactions.ts'
/** Long rendering-frame instrumentation. */
export * as LongFrames from './ui/LongFrames.ts'
/** Same-origin OTLP transport with browser lifecycle policies. */
export * as OtlpTransport from './OtlpTransport.ts'
/** Head sampling policies for local roots. */
export * as Sampler from './Sampler.ts'
/** Bounded in-process span and vitals snapshots. */
export * as SpanRing from './SpanRing.ts'
/** Core Web Vitals observations. */
export * as WebVitals from './ui/WebVitals.ts'
