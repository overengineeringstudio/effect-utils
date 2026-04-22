import {
  getManualVideoChapter,
  MANUAL_VIDEO_SOURCE_FILE,
  renderManualVideoSource,
} from "./chapters.ts";
import { readFileSync } from "node:fs";

export type ManualVideoTransitionPlan = {
  readonly fromChapterId: string;
  readonly toChapterId: string;
  readonly fromLineCount: number;
  readonly toLineCount: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly removedLineCount: number;
  readonly insertedLines: readonly string[];
  readonly insertedChunks: readonly (readonly string[])[];
  readonly focusLine: number;
  readonly changeKind: "no-op" | "single-line" | "block";
};

const splitLines = (value: string): readonly string[] =>
  value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n");

const isStableSuffixBoundaryLine = (line: string): boolean => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (/^[)\]}]+$/.test(trimmed)) return false;
  if (/^<\/[A-Za-z0-9_.-]+>$/.test(trimmed)) return false;
  return true;
};

const chunkInsertedLines = (
  lines: readonly string[],
  maxChunkSize = 8,
): readonly (readonly string[])[] => {
  if (lines.length === 0) return [];

  const chunks: string[][] = [];
  let current: string[] = [];

  const flush = (): void => {
    if (current.length === 0) return;
    chunks.push(current);
    current = [];
  };

  for (const line of lines) {
    current.push(line);
    if (line.trim() === "" || current.length >= maxChunkSize) {
      flush();
    }
  }

  flush();
  return chunks;
};

export const buildManualVideoTransitionPlan = (
  fromChapterId: string,
  toChapterId: string,
): ManualVideoTransitionPlan => {
  const fromSource = renderManualVideoSource(getManualVideoChapter(fromChapterId));
  return buildSourceToManualVideoTransitionPlan(fromSource, toChapterId, fromChapterId);
};

export const buildSourceToManualVideoTransitionPlan = (
  fromSource: string,
  toChapterId: string,
  fromChapterId = "live-source",
): ManualVideoTransitionPlan => {
  const toSource = renderManualVideoSource(getManualVideoChapter(toChapterId));
  const fromLines = splitLines(fromSource);
  const toLines = splitLines(toSource);

  let prefixLength = 0;
  while (
    prefixLength < fromLines.length &&
    prefixLength < toLines.length &&
    fromLines[prefixLength] === toLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < fromLines.length - prefixLength &&
    suffixLength < toLines.length - prefixLength &&
    fromLines[fromLines.length - 1 - suffixLength] ===
      toLines[toLines.length - 1 - suffixLength] &&
    isStableSuffixBoundaryLine(fromLines[fromLines.length - 1 - suffixLength]!)
  ) {
    suffixLength += 1;
  }

  const insertedLines = toLines.slice(prefixLength, toLines.length - suffixLength);
  const removedLineCount = fromLines.length - prefixLength - suffixLength;
  const startLine = prefixLength + 1;
  const endLine = prefixLength + removedLineCount;
  const insertedChunks = chunkInsertedLines(insertedLines);
  const changeKind: ManualVideoTransitionPlan["changeKind"] =
    removedLineCount === 0 && insertedLines.length === 0
      ? "no-op"
      : removedLineCount === 1 && insertedLines.length === 1
        ? "single-line"
        : "block";

  const focusLine =
    insertedLines.length > 0
      ? startLine + Math.min(insertedLines.length - 1, 6)
      : Math.max(1, Math.min(startLine, toLines.length));

  return {
    fromChapterId,
    toChapterId,
    fromLineCount: fromLines.length,
    toLineCount: toLines.length,
    startLine,
    endLine,
    removedLineCount,
    insertedLines,
    insertedChunks,
    focusLine,
    changeKind,
  };
};

if (import.meta.main) {
  const fromChapterId = process.argv[2];
  const toChapterId = process.argv[3];
  const liveFlag = process.argv[4];

  if (!fromChapterId || !toChapterId) {
    throw new Error(
      "usage: bun src/demo/manual-video/transition-plan.ts <from-chapter-id> <to-chapter-id> [--live]",
    );
  }

  console.log(
    JSON.stringify(
      liveFlag === "--live"
        ? buildSourceToManualVideoTransitionPlan(
            readFileSync(MANUAL_VIDEO_SOURCE_FILE, "utf8"),
            toChapterId,
            fromChapterId,
          )
        : buildManualVideoTransitionPlan(fromChapterId, toChapterId),
      null,
      2,
    ),
  );
}
