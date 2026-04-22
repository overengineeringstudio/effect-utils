import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { NOTION_API_VERSION } from "@overeng/notion-effect-client";

import {
  getManualVideoChapter,
  MANUAL_VIDEO_DEFAULT_PAGE_ID,
  MANUAL_VIDEO_SOURCE_FILE,
} from "./chapters.ts";

type ValidationCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly details: string;
};

type NotionBlock = {
  readonly id: string;
  readonly type: string;
  readonly has_children?: boolean;
  readonly [key: string]: unknown;
};

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizePageId = (value: string): string => {
  const trimmed = value.trim();
  const match = trimmed.match(/([0-9a-f]{32})/i);
  if (match) return match[1]!;
  return trimmed.replace(/-/g, "");
};

const readIfExists = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, "utf8") : undefined;

const normalizeTextForContains = (value: string): string =>
  value
    .replace(/\s+/g, " ")
    .replace(/\s+([.,:;!?])/g, "$1")
    .trim();

const captureTmuxPane = (target: string): string | undefined => {
  try {
    return execFileSync(
      "tmux",
      ["capture-pane", "-p", "-J", "-t", target, "-S", "-200"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch {
    return undefined;
  }
};

const captureWindow = (
  scriptFile: string,
  selector: "ghostty-id" | "chrome-id",
  outputFile: string,
): string | undefined => {
  try {
    const windowId = execFileSync("swift", [scriptFile, selector], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    execFileSync("screencapture", [`-l${windowId}`, "-x", outputFile], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    return outputFile;
  } catch {
    return undefined;
  }
};

const stitchImages = (
  leftFile: string | undefined,
  rightFile: string | undefined,
  outputFile: string,
): string | undefined => {
  if (leftFile === undefined || rightFile === undefined) return undefined;
  try {
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        leftFile,
        "-i",
        rightFile,
        "-filter_complex",
        "[0:v][1:v]scale2ref=oh*mdar:ih[left][right];[left][right]hstack=inputs=2",
        "-frames:v",
        "1",
        outputFile,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    return outputFile;
  } catch {
    return undefined;
  }
};

const richTextPlainText = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const plainText = (entry as { plain_text?: unknown }).plain_text;
    return typeof plainText === "string" && plainText.length > 0
      ? [plainText]
      : [];
  });
};

const blockPlainText = (block: NotionBlock): string[] => {
  const payload = block[block.type];
  if (typeof payload !== "object" || payload === null) return [];

  const richText = richTextPlainText(
    (payload as { rich_text?: unknown }).rich_text,
  );
  if (richText.length > 0) return richText;

  const title = (payload as { title?: unknown }).title;
  return typeof title === "string" && title.length > 0 ? [title] : [];
};

const fetchBlockChildren = async (
  token: string,
  blockId: string,
): Promise<readonly NotionBlock[]> => {
  const blocks: NotionBlock[] = [];
  let nextCursor: string | undefined;

  do {
    const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (nextCursor) url.searchParams.set("start_cursor", nextCursor);

    let body:
      | {
          readonly results: readonly NotionBlock[];
          readonly has_more: boolean;
          readonly next_cursor: string | null;
        }
      | undefined;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_API_VERSION,
        },
      });

      if (response.ok) {
        body = (await response.json()) as {
          readonly results: readonly NotionBlock[];
          readonly has_more: boolean;
          readonly next_cursor: string | null;
        };
        break;
      }

      if (response.status < 500 || attempt === 5) {
        throw new Error(
          `notion children request failed (${response.status}) for ${blockId}`,
        );
      }

      await sleep(attempt * 250);
    }

    if (body === undefined) {
      throw new Error(`notion children request did not return a body for ${blockId}`);
    }

    blocks.push(...body.results);
    nextCursor = body.has_more ? (body.next_cursor ?? undefined) : undefined;
  } while (nextCursor);

  return blocks;
};

const flattenPagePlainText = async (
  token: string,
  blockId: string,
): Promise<string> => {
  const visit = async (currentId: string): Promise<string[]> => {
    const blocks = await fetchBlockChildren(token, currentId);
    const output: string[] = [];
    for (const block of blocks) {
      output.push(...blockPlainText(block));
      if (block.has_children === true) {
        output.push(...(await visit(block.id)));
      }
    }
    return output;
  };

  return (await visit(blockId)).join("\n");
};

const main = async (): Promise<void> => {
  const chapterId = process.argv[2];
  if (!chapterId) {
    throw new Error(
      "usage: bun src/demo/manual-video/validate.ts <chapter-id> [page-id] [out-dir]",
    );
  }

  const pageId = normalizePageId(
    process.argv[3] ??
      process.env.NOTION_DEMO_PAGE_ID ??
      MANUAL_VIDEO_DEFAULT_PAGE_ID,
  );
  const outDir =
    process.argv[4] ??
    path.join(
      process.cwd(),
      "tmp",
      "notion-video-validation",
      chapterId.replaceAll("/", "-"),
    );

  mkdirSync(outDir, { recursive: true });

  const chapter = getManualVideoChapter(chapterId);
  const currentSource = readIfExists(MANUAL_VIDEO_SOURCE_FILE);
  const sourceIncludesChapterMarker =
    currentSource?.includes(`Generated from ${chapter.id}`) === true;
  const sourceIncludesSyncMarker =
    chapter.sourceBody.includes("syncMarker") === false ||
    currentSource?.includes("const syncMarker") === true;
  const sourceIncludesStageLabel =
    chapter.sourceBody.includes("stageLabel") === false ||
    currentSource?.includes(chapter.stageLabel) === true;
  const topPaneText = captureTmuxPane("notion-demo-video:1.1");
  const bottomPaneText = captureTmuxPane("notion-demo-video:1.2");

  const windowScript = path.join(
    process.cwd(),
    "scripts",
    "manual-video",
    "window-bounds.swift",
  );
  const terminalScreenshot = captureWindow(
    windowScript,
    "ghostty-id",
    path.join(outDir, "terminal.png"),
  );
  const browserScreenshot = captureWindow(
    windowScript,
    "chrome-id",
    path.join(outDir, "browser.png"),
  );
  const combinedScreenshot = stitchImages(
    terminalScreenshot,
    browserScreenshot,
    path.join(outDir, "combined.png"),
  );

  const checks: ValidationCheck[] = [];
  checks.push({
    name: "source file exists",
    ok: currentSource !== undefined,
    details: currentSource === undefined ? MANUAL_VIDEO_SOURCE_FILE : "present",
  });
  checks.push({
    name: "source reflects tracked chapter",
    ok:
      currentSource !== undefined &&
      sourceIncludesChapterMarker &&
      sourceIncludesSyncMarker &&
      sourceIncludesStageLabel,
    details:
      currentSource !== undefined &&
      sourceIncludesChapterMarker &&
      sourceIncludesSyncMarker &&
      sourceIncludesStageLabel
        ? chapter.id
        : `current source is missing chapter markers for ${chapter.id}`,
  });
  checks.push({
    name: "top pane captured",
    ok: topPaneText !== undefined,
    details: topPaneText === undefined ? "tmux pane unavailable" : "captured",
  });
  checks.push({
    name: "bottom pane captured",
    ok: bottomPaneText !== undefined,
    details:
      bottomPaneText === undefined ? "tmux pane unavailable" : "captured",
  });
  checks.push({
    name: "terminal sync proof visible",
    ok:
      (bottomPaneText ?? "").includes("SYNC OK") &&
      (bottomPaneText ?? "").includes("notion_api_calls="),
    details:
      (bottomPaneText ?? "").includes("SYNC OK") &&
      (bottomPaneText ?? "").includes("notion_api_calls=")
        ? 'found sync summary with "SYNC OK" and "notion_api_calls="'
        : "missing structured sync summary in lower tmux pane",
  });
  checks.push({
    name: "combined screenshot captured",
    ok: combinedScreenshot !== undefined,
    details: combinedScreenshot ?? "window bounds unavailable",
  });
  checks.push({
    name: "browser screenshot captured",
    ok: browserScreenshot !== undefined,
    details: browserScreenshot ?? "window bounds unavailable",
  });
  checks.push({
    name: "terminal screenshot captured",
    ok: terminalScreenshot !== undefined,
    details: terminalScreenshot ?? "window bounds unavailable",
  });

  const notionToken = process.env.NOTION_TOKEN;
  let pagePlainText = "";
  if (!notionToken) {
    checks.push({
      name: "notion api validation",
      ok: false,
      details: "NOTION_TOKEN is required for API validation",
    });
  } else {
    pagePlainText = await flattenPagePlainText(notionToken, pageId);
    const normalizedPageText = normalizeTextForContains(pagePlainText);
    if (chapter.expectEmptyBody === true) {
      checks.push({
        name: "notion api body starts empty",
        ok: normalizedPageText.length === 0,
        details:
          normalizedPageText.length === 0
            ? "body is empty"
            : `body still contains ${normalizedPageText.length} normalized characters`,
      });
    }
    for (const text of chapter.expectedApiTexts) {
      const normalizedExpected = normalizeTextForContains(text);
      checks.push({
        name: `notion api contains "${text}"`,
        ok: normalizedPageText.includes(normalizedExpected),
        details: normalizedPageText.includes(normalizedExpected)
          ? "present"
          : "missing",
      });
    }
  }

  if (topPaneText !== undefined && chapter.sourceBody.includes("stageLabel")) {
    checks.push({
      name: "top pane shows current stage label",
      ok: topPaneText.includes(chapter.stageLabel),
      details: topPaneText.includes(chapter.stageLabel)
        ? chapter.stageLabel
        : `missing ${chapter.stageLabel} in top pane`,
    });
  }

  const report = {
    chapter: {
      id: chapter.id,
      title: chapter.title,
      beatRange: chapter.beatRange,
      goal: chapter.goal,
      syncMarker: chapter.syncMarker,
      stageLabel: chapter.stageLabel,
    },
    pageId,
    artifacts: {
      combinedScreenshot,
      browserScreenshot,
      terminalScreenshot,
      topPaneTextFile: path.join(outDir, "top-pane.txt"),
      bottomPaneTextFile: path.join(outDir, "bottom-pane.txt"),
    },
    checks,
    ok: checks.every((check) => check.ok),
  };

  if (topPaneText !== undefined) {
    writeFileSync(path.join(outDir, "top-pane.txt"), `${topPaneText}\n`);
  }
  if (bottomPaneText !== undefined) {
    writeFileSync(path.join(outDir, "bottom-pane.txt"), `${bottomPaneText}\n`);
  }
  if (pagePlainText.length > 0) {
    writeFileSync(
      path.join(outDir, "page-plain-text.txt"),
      `${pagePlainText}\n`,
    );
  }

  const reportFile = path.join(outDir, "validation-report.json");
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exit(1);
  }
};

await main();
