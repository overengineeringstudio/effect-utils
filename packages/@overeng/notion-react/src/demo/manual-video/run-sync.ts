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
const ansi = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  red: "\u001B[31m",
  cyan: "\u001B[36m",
  blue: "\u001B[34m",
  yellow: "\u001B[33m",
  gray: "\u001B[90m",
} as const;

const pageId = (
  process.argv[2] ??
  process.env.NOTION_DEMO_PAGE_ID ??
  MANUAL_VIDEO_DEFAULT_PAGE_ID
).trim();
const syncRunId = process.env.NOTION_SYNC_RUN_ID?.trim() || undefined;

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
  const statusColor = opts.ok ? ansi.green : ansi.red;
  const diffSummary =
    opts.result === undefined
      ? "n/a"
      : `+${opts.result.appends}  ^${opts.result.inserts}  ~${opts.result.updates}  -${opts.result.removes}`;
  const httpSummary = `GET ${actual.retrieve}  APP ${actual.append}  UPD ${actual.update}  DEL ${actual.delete}`;

  console.log(
    `${statusColor}${ansi.bold}${status}${ansi.reset} ${ansi.cyan}duration_ms=${formatDuration(opts.durationMs)}${ansi.reset} ${ansi.blue}notion_api_calls=${totalCalls}${ansi.reset} ${ansi.dim}cache=${formatCache(opts.metrics?.cacheOutcome)} fallback=${formatFallback(opts.metrics?.fallbackReason)}${syncRunId !== undefined ? ` sync_run_id=${syncRunId}` : ""}${ansi.reset}`,
  );

  if (opts.result !== undefined) {
    console.log(
      `${ansi.yellow}${ansi.bold}SYNC DIFF${ansi.reset} ${diffSummary} ${ansi.dim}appends=${opts.result.appends} inserts=${opts.result.inserts} updates=${opts.result.updates} removes=${opts.result.removes}${ansi.reset}`,
    );
  }

  console.log(
    `${ansi.gray}${ansi.bold}SYNC HTTP${ansi.reset} ${ansi.gray}${httpSummary}  flush=${opts.metrics?.batchCount ?? 0}  noop=${opts.metrics?.updateNoopCount ?? 0}  retrieve=${actual.retrieve} append=${actual.append} update=${actual.update} delete=${actual.delete} batch_flushes=${opts.metrics?.batchCount ?? 0} update_noops=${opts.metrics?.updateNoopCount ?? 0}${ansi.reset}`,
  );

  if (opts.error !== undefined) {
    console.log(
      `${ansi.red}${ansi.bold}SYNC MESSAGE${ansi.reset} ${ansi.red}${opts.error}${ansi.reset}`,
    );
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
