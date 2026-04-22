import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
  getManualVideoChapter,
  MANUAL_VIDEO_SOURCE_FILE,
  manualVideoChapterIds,
  renderManualVideoSource,
} from "./chapters.ts";

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const id of manualVideoChapterIds) {
    console.log(id);
  }
  process.exit(0);
}

const defaultChapterId = manualVideoChapterIds[0];
if (defaultChapterId === undefined) {
  throw new Error("manual video chapters are not configured");
}

const chapterId = args[0] ?? defaultChapterId;
const outputFile = args[1] ?? MANUAL_VIDEO_SOURCE_FILE;
const chapter = getManualVideoChapter(chapterId);
const source = renderManualVideoSource(chapter);

mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(outputFile, source);

console.log(
  JSON.stringify(
    {
      chapterId: chapter.id,
      outputFile,
      syncMarker: chapter.syncMarker,
      stageLabel: chapter.stageLabel,
    },
    null,
    2,
  ),
);
