import { describe, expect, it } from "vitest";

import {
  getManualVideoChapter,
  manualVideoChapterIds,
  manualVideoChapters,
  renderManualVideoSource,
} from "./manual-video/chapters.ts";

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
    }
  });
});
