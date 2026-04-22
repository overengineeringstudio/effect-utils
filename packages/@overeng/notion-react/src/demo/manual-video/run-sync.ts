import * as path from "node:path";

import { FetchHttpClient } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";

import { NotionConfig } from "@overeng/notion-effect-client";

import { FsCache } from "../../cache/mod.ts";
import type { SyncMetrics } from "../../renderer/mod.ts";
import { sync } from "../../renderer/mod.ts";

import source from "../../../tmp/notion-video-manual-demo.tsx";

import { MANUAL_VIDEO_DEFAULT_PAGE_ID } from "./chapters.ts";

const CACHE_KEY = "notion-video-manual-demo";

const pageId = (
  process.argv[2] ??
  process.env.NOTION_DEMO_PAGE_ID ??
  MANUAL_VIDEO_DEFAULT_PAGE_ID
).trim();

const notionToken = process.env.NOTION_TOKEN;
if (!notionToken) {
  throw new Error("NOTION_TOKEN is required");
}

const layer = Layer.mergeAll(
  Layer.succeed(NotionConfig, {
    authToken: Redacted.make(notionToken),
    retryEnabled: true,
    maxRetries: 5,
    retryBaseDelay: 1000,
  }),
  FetchHttpClient.layer,
);

const formatFallback = (
  value: SyncMetrics["fallbackReason"] | undefined,
): string => (value === null || value === undefined ? "none" : value);

const formatCache = (value: SyncMetrics["cacheOutcome"] | undefined): string =>
  value === null || value === undefined ? "unknown" : value;

const formatDuration = (value: number | undefined): number =>
  Math.round(value ?? 0);

const printSummary = (opts: {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly metrics: SyncMetrics | undefined;
  readonly result:
    | {
        readonly appends: number;
        readonly inserts: number;
        readonly updates: number;
        readonly removes: number;
      }
    | undefined;
  readonly error?: string;
}): void => {
  const actual = opts.metrics?.actualOps ?? {
    append: 0,
    update: 0,
    delete: 0,
    retrieve: 0,
  };
  const totalCalls =
    actual.append + actual.update + actual.delete + actual.retrieve;
  const status = opts.ok ? "SYNC OK" : "SYNC ERROR";

  console.log(
    `${status} duration_ms=${formatDuration(opts.durationMs)} notion_api_calls=${totalCalls} cache=${formatCache(opts.metrics?.cacheOutcome)} fallback=${formatFallback(opts.metrics?.fallbackReason)}`,
  );

  if (opts.result !== undefined) {
    console.log(
      `SYNC DIFF appends=${opts.result.appends} inserts=${opts.result.inserts} updates=${opts.result.updates} removes=${opts.result.removes}`,
    );
  }

  console.log(
    `SYNC HTTP retrieve=${actual.retrieve} append=${actual.append} update=${actual.update} delete=${actual.delete} batch_flushes=${opts.metrics?.batchCount ?? 0} update_noops=${opts.metrics?.updateNoopCount ?? 0}`,
  );

  if (opts.error !== undefined) {
    console.log(`SYNC MESSAGE ${opts.error}`);
  }
};

let metrics: SyncMetrics | undefined;
const startedAt = performance.now();

try {
  const result = await Effect.runPromise(
    sync(source, {
      pageId,
      cache: FsCache.make(
        path.join(
          process.cwd(),
          "tmp",
          "notion-demo-cache",
          `${CACHE_KEY}.${pageId}.json`,
        ),
      ),
      onMetrics: (next) => {
        metrics = next;
      },
    }).pipe(Effect.provide(layer)),
  );

  printSummary({
    ok: true,
    durationMs: metrics?.durationMs ?? performance.now() - startedAt,
    metrics,
    result: {
      appends: result.appends,
      inserts: result.inserts,
      updates: result.updates,
      removes: result.removes,
    },
  });
} catch (error) {
  printSummary({
    ok: false,
    durationMs: metrics?.durationMs ?? performance.now() - startedAt,
    metrics,
    result: undefined,
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}
