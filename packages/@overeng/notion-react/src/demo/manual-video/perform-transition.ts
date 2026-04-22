import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { MANUAL_VIDEO_SOURCE_FILE } from "./chapters.ts";
import { buildSourceToManualVideoTransitionPlan } from "./transition-plan.ts";

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const runTmux = (
  args: readonly string[],
  options?: {
    readonly input?: string;
  },
): void => {
  execFileSync("tmux", args, {
    stdio: ["pipe", "pipe", "pipe"],
    input: options?.input,
  });
};

const sendKeys = (target: string, ...keys: readonly string[]): void => {
  runTmux(["send-keys", "-t", target, ...keys]);
};

const pasteText = (target: string, text: string): void => {
  runTmux(["load-buffer", "-"], { input: text });
  runTmux(["paste-buffer", "-d", "-t", target]);
};

const focusLine = async (target: string, line: number): Promise<void> => {
  sendKeys(target, "Escape");
  sendKeys(target, `:${Math.max(1, line)}`, "Enter");
  sendKeys(target, "z", "z");
  await sleep(120);
};

const startInsertAtLine = async (
  target: string,
  line: number,
  fromLineCount: number,
): Promise<void> => {
  sendKeys(target, "Escape");
  if (line <= 1) {
    sendKeys(target, "g", "g");
    sendKeys(target, "O");
  } else if (line > fromLineCount) {
    sendKeys(target, "G");
    sendKeys(target, "o");
  } else {
    sendKeys(target, `:${line - 1}`, "Enter");
    sendKeys(target, "o");
  }
  await sleep(100);
};

const insertChunk = async (
  target: string,
  chunkLines: readonly string[],
  firstChunk: boolean,
): Promise<void> => {
  if (firstChunk === false) {
    sendKeys(target, "Escape");
    sendKeys(target, "o");
    await sleep(80);
  }

  pasteText(target, chunkLines.join("\n"));
  await sleep(140);
  sendKeys(target, "Escape");
  await sleep(80);
};

const main = async (): Promise<void> => {
  const fromChapterId = process.argv[2];
  const toChapterId = process.argv[3];
  const targetPane = process.argv[4];

  if (!fromChapterId || !toChapterId || !targetPane) {
    throw new Error(
      "usage: bun src/demo/manual-video/perform-transition.ts <from-chapter-id> <to-chapter-id> <tmux-pane-target>",
    );
  }

  const plan = buildSourceToManualVideoTransitionPlan(
    readFileSync(MANUAL_VIDEO_SOURCE_FILE, "utf8"),
    toChapterId,
    fromChapterId,
  );

  await focusLine(targetPane, plan.focusLine);

  if (plan.changeKind !== "no-op") {
    sendKeys(targetPane, ":set paste", "Enter");
    await sleep(80);

    if (plan.removedLineCount > 0) {
      sendKeys(
        targetPane,
        `:${plan.startLine},${plan.endLine}delete _`,
        "Enter",
      );
      await sleep(120);
    }

    if (plan.insertedChunks.length > 0) {
      await startInsertAtLine(
        targetPane,
        plan.startLine,
        plan.fromLineCount - plan.removedLineCount,
      );

      let firstChunk = true;
      for (const chunk of plan.insertedChunks) {
        await insertChunk(targetPane, chunk, firstChunk);
        firstChunk = false;
      }
    }

    sendKeys(targetPane, "Escape");
    sendKeys(targetPane, ":set nopaste", "Enter");
    await sleep(80);
  }

  await focusLine(targetPane, plan.focusLine);
  sendKeys(targetPane, "Escape");
  sendKeys(targetPane, ":write", "Enter");
  await sleep(120);

  console.log(
    JSON.stringify(
      {
        ...plan,
        tmuxPane: targetPane,
      },
      null,
      2,
    ),
  );
};

await main();
