import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { getManualVideoChapter } from "./chapters.ts";

type ManifestEntry = {
  readonly chapterId: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
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

const dialogueLines = manifest.flatMap((entry) => {
  const chapter = getManualVideoChapter(entry.chapterId);
  const overlayStart = entry.startSeconds + 0.2;
  const overlayEnd = Math.min(entry.endSeconds, overlayStart + 3.8);

  if (overlayEnd <= overlayStart) return [];

  const title = escapeAss(chapter.overlayTitle);
  const body = escapeAss(chapter.overlayBody);
  const beat = escapeAss(chapter.beatRange);

  return [
    `Dialogue: 0,${toAssTime(overlayStart)},${toAssTime(overlayEnd)},Title,,0,0,0,,${title}`,
    `Dialogue: 0,${toAssTime(overlayStart + 0.15)},${toAssTime(overlayEnd)},Body,,0,0,0,,${body}\\N{\\\\alpha&HCC&}${beat}`,
  ];
});

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Helvetica Neue,28,&H00FFFFFF,&H000000FF,&H8A000000,&H64000000,1,0,0,0,100,100,0,0,1,2,0,7,36,36,40,1
Style: Body,Helvetica Neue,17,&H00F2F2F2,&H000000FF,&H7A000000,&H50000000,0,0,0,0,100,100,0,0,1,1,0,7,36,36,82,1

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
