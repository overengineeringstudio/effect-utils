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

const manifestFile = process.argv[2];
if (!manifestFile) {
  throw new Error(
    "usage: bun src/demo/manual-video/render-overlays.ts <manifest.jsonl> [output.ass]",
  );
}

const outputFile =
  process.argv[3] ??
  path.join(path.dirname(manifestFile), "chapter-overlays.ass");

const PLAY_RES_X = 1920;
const CONTENT_HEIGHT = Number(process.env.NOTION_VIDEO_CONTENT_HEIGHT ?? "1080");
const BAND_HEIGHT = Number(process.env.NOTION_VIDEO_BAND_HEIGHT ?? "220");
const PLAY_RES_Y = CONTENT_HEIGHT + BAND_HEIGHT;
const BAND_TOP = CONTENT_HEIGHT;
const LEFT_MARGIN = 72;
const RIGHT_MARGIN = 72;
const TITLE_Y = BAND_TOP + 48;
const BODY_Y = BAND_TOP + 106;
const COUNT_Y = BAND_TOP + 52;
const PROGRESS_Y = BAND_TOP + 178;
const SUMMARY_Y = BAND_TOP + 108;
const SUMMARY_X = PLAY_RES_X - RIGHT_MARGIN;

const toAssTime = (seconds: number): string => {
  const totalCentiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(totalCentiseconds / 360000);
  const minutes = Math.floor((totalCentiseconds % 360000) / 6000);
  const secs = Math.floor((totalCentiseconds % 6000) / 100);
  const centis = totalCentiseconds % 100;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
};

const escapeAss = (value: string): string =>
  value
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll("\n", "\\N");

const manifest = readFileSync(manifestFile, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as ManifestEntry);

if (manifest.length === 0) {
  throw new Error(`manifest is empty: ${manifestFile}`);
}

const renderProgress = (index: number, total: number): string =>
  Array.from({ length: total }, (_, segmentIndex) => {
    if (segmentIndex < index) {
      return "{\\c&HF7C987&\\bord1\\shad0}━━━━";
    }
    if (segmentIndex === index) {
      return "{\\c&HFFFFFF&\\bord1\\shad0}━━━━";
    }
    return "{\\c&H4B4B55&\\alpha&H12&\\bord1\\shad0}━━━━";
  }).join("{\\fsp8}");

const formatSyncSummary = (entry: ManifestEntry): string => {
  const durationSeconds =
    entry.durationMs === undefined ? "n/a" : `${(entry.durationMs / 1000).toFixed(1)}s`;
  const apiCalls =
    entry.notionApiCalls === undefined ? "n/a" : String(entry.notionApiCalls);
  const appends = entry.diffAppends ?? 0;
  const inserts = entry.diffInserts ?? 0;
  const updates = entry.diffUpdates ?? 0;
  const removes = entry.diffRemoves ?? 0;

  return [
    "{\\fs18\\c&H8EA0BF&\\bord0\\shad0}SYNC SUMMARY",
    `{\\fs26\\c&HFFFFFF&\\b1\\bord0\\shad0}${durationSeconds}  ·  ${apiCalls} calls`,
    `{\\fs22\\c&HD6D9E1&\\bord0\\shad0}+${appends}  ^${inserts}  ~${updates}  -${removes}`,
  ].join("\\N");
};

const dialogueLines = manifest.flatMap((entry, index) => {
  const chapter = getManualVideoChapter(entry.chapterId);
  const overlayStart = entry.startSeconds;
  const overlayEnd = entry.endSeconds;

  if (overlayEnd <= overlayStart) return [];

  const title = escapeAss(chapter.overlayTitle);
  const body = escapeAss(chapter.overlayBody);
  const beat = escapeAss(chapter.beatRange);
  const count = `${String(index + 1).padStart(2, "0")} / ${String(manifest.length).padStart(2, "0")}`;
  const progress = renderProgress(index, manifest.length);
  const summary = formatSyncSummary(entry);

  return [
    `Dialogue: 0,${toAssTime(overlayStart)},${toAssTime(overlayEnd)},Title,,0,0,0,,{\\pos(${LEFT_MARGIN},${TITLE_Y})}${title}`,
    `Dialogue: 0,${toAssTime(overlayStart)},${toAssTime(overlayEnd)},Body,,0,0,0,,{\\pos(${LEFT_MARGIN},${BODY_Y})}${body}\\N{\\\\alpha&HAA&}${beat}`,
    `Dialogue: 0,${toAssTime(overlayStart)},${toAssTime(overlayEnd)},Count,,0,0,0,,{\\pos(${PLAY_RES_X - RIGHT_MARGIN},${COUNT_Y})}${escapeAss(count)}`,
    `Dialogue: 0,${toAssTime(overlayStart)},${toAssTime(overlayEnd)},Progress,,0,0,0,,{\\pos(${LEFT_MARGIN},${PROGRESS_Y})}${progress}`,
    `Dialogue: 0,${toAssTime(overlayStart)},${toAssTime(overlayEnd)},Summary,,0,0,0,,{\\pos(${SUMMARY_X},${SUMMARY_Y})}${summary}`,
  ];
});

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${PLAY_RES_X}
PlayResY: ${PLAY_RES_Y}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Helvetica Neue,42,&H00FFFFFF,&H000000FF,&H8A000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1
Style: Body,Helvetica Neue,26,&H00F2F2F2,&H000000FF,&H7A000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,7,0,0,0,1
Style: Count,Helvetica Neue,26,&H00D7DEEF,&H000000FF,&H7A000000,&H00000000,1,0,0,0,100,100,0,0,1,1,0,9,0,0,0,1
Style: Progress,Helvetica Neue,36,&H00FFFFFF,&H000000FF,&H5A000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,8,0,0,0,1
Style: Summary,Helvetica Neue,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,9,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${dialogueLines.join("\n")}
`;

mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(outputFile, ass);

console.log(
  JSON.stringify(
    {
      manifestFile,
      outputFile,
      chapterCount: manifest.length,
    },
    null,
    2,
  ),
);
