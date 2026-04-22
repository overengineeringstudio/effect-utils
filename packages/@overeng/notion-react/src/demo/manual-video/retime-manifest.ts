import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { getManualVideoChapter } from "./chapters.ts";

type ManifestEntry = {
  readonly chapterId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly durationMs?: number;
  readonly notionApiCalls?: number;
  readonly diffAppends?: number;
  readonly diffInserts?: number;
  readonly diffUpdates?: number;
  readonly diffRemoves?: number;
};

const inputManifestFile = process.argv[2];
if (!inputManifestFile) {
  throw new Error(
    "usage: bun src/demo/manual-video/retime-manifest.ts <input-manifest.jsonl> [output-manifest.jsonl] [output-plan.tsv]",
  );
}

const outputManifestFile =
  process.argv[3] ??
  path.join(path.dirname(inputManifestFile), "manifest-retimed.jsonl");
const outputPlanFile =
  process.argv[4] ?? path.join(path.dirname(inputManifestFile), "retime-plan.tsv");

const manifest = readFileSync(inputManifestFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as ManifestEntry);

let nextStartSeconds = 0;
const retimedManifest: ManifestEntry[] = [];
const planLines = ["chapterId\trawStartSeconds\trawEndSeconds\trawDurationSeconds\ttargetDurationSeconds"];

for (const entry of manifest) {
  const chapter = getManualVideoChapter(entry.chapterId);
  const rawDurationSeconds = Math.max(0.001, entry.endSeconds - entry.startSeconds);
  const targetDurationSeconds = chapter.targetDurationSeconds;
  const retimedEntry: ManifestEntry = {
    ...entry,
    startSeconds: Number(nextStartSeconds.toFixed(3)),
    endSeconds: Number((nextStartSeconds + targetDurationSeconds).toFixed(3)),
  };

  retimedManifest.push(retimedEntry);
  planLines.push(
    [
      entry.chapterId,
      entry.startSeconds.toFixed(3),
      entry.endSeconds.toFixed(3),
      rawDurationSeconds.toFixed(3),
      targetDurationSeconds.toFixed(3),
    ].join("\t"),
  );
  nextStartSeconds += targetDurationSeconds;
}

mkdirSync(path.dirname(outputManifestFile), { recursive: true });
mkdirSync(path.dirname(outputPlanFile), { recursive: true });
writeFileSync(
  outputManifestFile,
  retimedManifest.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
);
writeFileSync(outputPlanFile, planLines.join("\n") + "\n");

console.log(
  JSON.stringify(
    {
      inputManifestFile,
      outputManifestFile,
      outputPlanFile,
      chapterCount: retimedManifest.length,
      totalDurationSeconds: Number(nextStartSeconds.toFixed(3)),
    },
    null,
    2,
  ),
);
