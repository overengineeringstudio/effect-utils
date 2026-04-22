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
      expect(source).toContain(chapter.syncMarker);
      expect(source).toContain(chapter.stageLabel);
      expect(source).toContain("await Effect.runPromise");
      expect(source).toContain(
        "const renderManualDemo = (ui: DemoUi): ReactElement => {",
      );
    }
  });

  it("fails fast for unknown chapters", () => {
    expect(() => getManualVideoChapter("missing")).toThrow(/unknown chapter/);
  });
});
