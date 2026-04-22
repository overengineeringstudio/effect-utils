import { describe, expect, it } from "vitest";

import {
  getManualVideoChapter,
  manualVideoChapterIds,
  manualVideoChapters,
  renderManualVideoSource,
} from "./manual-video/chapters.ts";
import { buildManualVideoTransitionPlan } from "./manual-video/transition-plan.ts";

describe("manual video chapters", () => {
  it("uses unique chapter ids", () => {
    expect(new Set(manualVideoChapterIds).size).toBe(
      manualVideoChapterIds.length,
    );
  });

  it("renders each chapter into a standalone sync source", () => {
    for (const chapter of manualVideoChapters) {
      const source = renderManualVideoSource(chapter);
      expect(source).toContain("import { ui");
      expect(source).toContain("export default");
      expect(source).toContain(`Generated from ${chapter.id}`);

      if (chapter.sourceBody.includes("syncMarker")) {
        expect(source).toContain(chapter.syncMarker);
      }

      if (chapter.sourceBody.includes("stageLabel")) {
        expect(source).toContain(chapter.stageLabel);
      }
    }
  });

  it("fails fast for unknown chapters", () => {
    expect(() => getManualVideoChapter("missing")).toThrow(/unknown chapter/);
  });

  it("exposes overlay copy for every chapter", () => {
    for (const chapter of manualVideoChapters) {
      expect(chapter.overlayTitle.length).toBeGreaterThan(0);
      expect(chapter.overlayBody.length).toBeGreaterThan(0);
      expect(chapter.targetDurationSeconds).toBeGreaterThan(0);
    }
  });

  it("builds contiguous editor transition plans between chapters", () => {
    for (let index = 1; index < manualVideoChapterIds.length; index += 1) {
      const fromChapterId = manualVideoChapterIds[index - 1]!;
      const toChapterId = manualVideoChapterIds[index]!;
      const plan = buildManualVideoTransitionPlan(fromChapterId, toChapterId);

      expect(plan.fromChapterId).toBe(fromChapterId);
      expect(plan.toChapterId).toBe(toChapterId);
      expect(plan.startLine).toBeGreaterThan(0);
      expect(plan.endLine).toBeGreaterThanOrEqual(plan.startLine - 1);
      expect(plan.insertedChunks.flat().join("\n")).toBe(
        plan.insertedLines.join("\n"),
      );

      if (plan.changeKind !== "no-op") {
        expect(plan.insertedLines.length + plan.removedLineCount).toBeGreaterThan(
          0,
        );
      }
    }
  });
});
