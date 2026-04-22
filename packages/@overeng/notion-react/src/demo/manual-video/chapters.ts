import * as path from "node:path";

export const MANUAL_VIDEO_DEFAULT_PAGE_ID = "34af141b18dc80ec8bb3e939c65131b9";
export const MANUAL_VIDEO_SOURCE_FILE = path.join(
  process.cwd(),
  "tmp",
  "notion-video-manual-demo.tsx",
);

export type ManualVideoChapter = {
  readonly id: string;
  readonly title: string;
  readonly beatRange: string;
  readonly goal: string;
  readonly syncMarker: string;
  readonly stageLabel: string;
  readonly overlayTitle: string;
  readonly overlayBody: string;
  readonly expectEmptyBody?: boolean;
  readonly expectedApiTexts: readonly string[];
  readonly expectedBrowserTexts: readonly string[];
  readonly sourceBody: string;
};

const chapters = [
  {
    id: "chapter-0-empty-page",
    title: "Chapter 0 - Empty Page",
    beatRange: "00:00-00:08",
    goal: "Start from a genuinely empty page body and a tiny TSX file.",
    syncMarker: "manual-demo-v0",
    stageLabel: "stage-0: empty page",
    overlayTitle: "Start from empty",
    overlayBody:
      "The page body is cleared first, and the source is intentionally tiny.",
    expectEmptyBody: true,
    expectedApiTexts: [],
    expectedBrowserTexts: [],
    sourceBody: String.raw`
const { Page } = ui

export default <Page />`,
  },
  {
    id: "chapter-1-hello-world",
    title: "Chapter 1 - Hello World",
    beatRange: "00:08-00:20",
    goal: "Establish the core loop with a tiny, legible page.",
    syncMarker: "manual-demo-v1",
    stageLabel: "stage-1: hello world",
    overlayTitle: "Hello world",
    overlayBody: "A minimal JSX file syncs into a real Notion page.",
    expectedApiTexts: [
      "Live sync demo",
      "Sync marker: manual-demo-v1",
      "Source of truth: JSX in tmux. Target: real Notion page.",
    ],
    expectedBrowserTexts: ["Live sync demo", "Sync marker: manual-demo-v1"],
    sourceBody: String.raw`
const { Page, Heading1, Paragraph, Callout, InlineCode } = ui

export default (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      Source of truth: JSX in tmux. Target: real Notion page.
    </Paragraph>
    <Callout {...keyed({ icon: '🧪', color: 'blue_background' }, 'status')}>
      Sync marker: {syncMarker}
    </Callout>
    <Paragraph {...keyed({}, 'instructions')}>
      Start with <InlineCode>{stageLabel}</InlineCode>, then grow the page block-by-block.
    </Paragraph>
  </Page>
)`,
  },
  {
    id: "chapter-2-marker-bump",
    title: "Chapter 2 - First Visible Mutation",
    beatRange: "00:20-00:30",
    goal: "Prove that a tiny source change causes a tiny visible delta.",
    syncMarker: "manual-demo-v2",
    stageLabel: "stage-2: one-line marker change",
    overlayTitle: "Tiny change, visible update",
    overlayBody:
      "One line changes in JSX. The Notion page reflects the new marker.",
    expectedApiTexts: [
      "Live sync demo",
      "Sync marker: manual-demo-v2",
      "stage-2: one-line marker change",
    ],
    expectedBrowserTexts: [
      "Sync marker: manual-demo-v2",
      "stage-2: one-line marker change",
    ],
    sourceBody: String.raw`
const { Page, Heading1, Paragraph, Callout, InlineCode } = ui

export default (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      Source of truth: JSX in tmux. Target: real Notion page.
    </Paragraph>
    <Callout {...keyed({ icon: '🧪', color: 'blue_background' }, 'status')}>
      Sync marker: {syncMarker}
    </Callout>
    <Paragraph {...keyed({}, 'instructions')}>
      The visible change in this chapter is intentionally tiny: <InlineCode>{stageLabel}</InlineCode>.
    </Paragraph>
  </Page>
)`,
  },
  {
    id: "chapter-3-structured-page",
    title: "Chapter 3 - Grow Into Structure",
    beatRange: "00:30-00:48",
    goal: "Move from a toy page to a small but meaningful Notion document.",
    syncMarker: "manual-demo-v3",
    stageLabel: "stage-3: structured page",
    overlayTitle: "Grow into structure",
    overlayBody:
      "Headings, bullets, and checklists make the page feel like a real doc.",
    expectedApiTexts: [
      "Demo loop",
      "Edit the JSX file in tmux.",
      "Keep the changed block above the fold.",
      "Prepare a richer page structure.",
    ],
    expectedBrowserTexts: ["Demo loop", "Quality bar"],
    sourceBody: String.raw`
const { Page, Heading1, Heading2, Paragraph, Callout, BulletedListItem, ToDo, InlineCode } = ui

export default (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      We start from empty, then grow a page that feels like a real working document.
    </Paragraph>
    <Callout {...keyed({ icon: '🚀', color: 'green_background' }, 'status')}>
      Sync marker: {syncMarker}. JSX stays the source of truth while Notion remains the review surface.
    </Callout>
    <Paragraph {...keyed({}, 'chapter-label')}>
      This chapter lands on <InlineCode>{stageLabel}</InlineCode>.
    </Paragraph>
    <Heading2 {...keyed({}, 'loop-heading')}>Demo loop</Heading2>
    <BulletedListItem {...keyed({}, 'loop-1')}>Edit the JSX file in tmux.</BulletedListItem>
    <BulletedListItem {...keyed({}, 'loop-2')}>Run the sync command in the lower pane.</BulletedListItem>
    <BulletedListItem {...keyed({}, 'loop-3')}>
      Watch the real Notion page reconcile to the new tree.
    </BulletedListItem>
    <Heading2 {...keyed({}, 'quality-heading')}>Quality bar</Heading2>
    <ToDo {...keyed({ checked: true }, 'todo-1')}>Keep the changed block above the fold.</ToDo>
    <ToDo {...keyed({ checked: true }, 'todo-2')}>Make the sync proof obvious in the terminal.</ToDo>
    <ToDo {...keyed({}, 'todo-3')}>Prepare a richer page structure.</ToDo>
  </Page>
)`,
  },
  {
    id: "chapter-4-refactor",
    title: "Chapter 4 - Refactor, Don’t Just Append",
    beatRange: "00:48-01:06",
    goal: "Show that maintainability comes from normal React refactors, not manual duplication.",
    syncMarker: "manual-demo-v4",
    stageLabel: "stage-4: refactor repeated blocks into data",
    overlayTitle: "Refactor the source",
    overlayBody:
      "The page stays visually correct while the JSX becomes more maintainable.",
    expectedApiTexts: [
      "Demo loop",
      "Quality bar",
      "Prepare a richer page structure.",
      "Refactor repeated blocks into data",
    ],
    expectedBrowserTexts: ["Demo loop", "Quality bar"],
    sourceBody: String.raw`
const { Page, Heading1, Heading2, Paragraph, Callout, BulletedListItem, ToDo, InlineCode } = ui

const loopSteps = [
  'Edit the JSX file in tmux.',
  'Run the sync command in the lower pane.',
  'Watch the real Notion page reconcile to the new tree.',
] as const

const qualityChecks = [
  { blockKey: 'todo-1', checked: true, text: 'Keep the changed block above the fold.' },
  { blockKey: 'todo-2', checked: true, text: 'Make the sync proof obvious in the terminal.' },
  { blockKey: 'todo-3', checked: false, text: 'Prepare a richer page structure.' },
] as const

export default (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      We start from empty, then grow a page that feels like a real working document.
    </Paragraph>
    <Callout {...keyed({ icon: '🧩', color: 'gray_background' }, 'status')}>
      Refactor repeated blocks into data with <InlineCode>{stageLabel}</InlineCode> while keeping
      the page visually stable.
    </Callout>
    <Heading2 {...keyed({}, 'loop-heading')}>Demo loop</Heading2>
    {loopSteps.map((step, index) => (
      <BulletedListItem key={step} {...keyed({}, 'loop-' + (index + 1))}>
        {step}
      </BulletedListItem>
    ))}
    <Heading2 {...keyed({}, 'quality-heading')}>Quality bar</Heading2>
    {qualityChecks.map((item) => (
      <ToDo
        key={item.blockKey}
        {...keyed({ checked: item.checked }, item.blockKey)}
      >
        {item.text}
      </ToDo>
    ))}
    <Paragraph {...keyed({}, 'marker')}>Refactor repeated blocks into data. Sync marker: {syncMarker}</Paragraph>
  </Page>
)`,
  },
  {
    id: "chapter-5-rich-page",
    title: "Chapter 5 - Credible End State",
    beatRange: "01:06-01:24",
    goal: "Land on a compact but rich page that proves the tool is viable for serious authoring.",
    syncMarker: "manual-demo-v5",
    stageLabel: "stage-5: rich hierarchical page",
    overlayTitle: "Land on a real page",
    overlayBody:
      "The final page is still legible, but clearly richer than the starting point.",
    expectedApiTexts: [
      "Delivery pipeline",
      "Launch brief",
      "Code in tmux",
      "Real Notion page",
      "Validation artifacts",
      "ship the chaptered demo runner",
      "Sync marker: manual-demo-v5",
    ],
    expectedBrowserTexts: [
      "Delivery pipeline",
      "Launch brief",
      "Validation artifacts",
    ],
    sourceBody: String.raw`
const {
  Page,
  Heading1,
  Heading2,
  Paragraph,
  Callout,
  NumberedListItem,
  Toggle,
  BulletedListItem,
  ToDo,
  ColumnList,
  Column,
  Bold,
  InlineCode,
} = ui

const pipeline = [
  'Edit the visible TSX source in tmux.',
  'Run sync and let the reconciler update the Notion tree incrementally.',
  'Validate the result with screenshots, terminal proof, and a Notion API read.',
] as const

const launchBrief = [
  'Code in tmux',
  'Real Notion page',
  'Validation artifacts',
] as const

export default (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      The same JSX file now drives a richer hierarchical Notion page through{' '}
      <InlineCode>{stageLabel}</InlineCode> without leaving the normal React authoring model.
    </Paragraph>
    <Callout {...keyed({ icon: '✅', color: 'green_background' }, 'status')}>
      Sync marker: {syncMarker}. The end state is compact, but it already looks like a
      credible working page.
    </Callout>
    <Heading2 {...keyed({}, 'pipeline-heading')}>Delivery pipeline</Heading2>
    {pipeline.map((step, index) => (
      <NumberedListItem key={step} {...keyed({}, 'pipeline-' + (index + 1))}>
        {step}
      </NumberedListItem>
    ))}
    <Toggle {...keyed({ title: 'Launch brief' }, 'launch-brief')}>
      <Paragraph {...keyed({}, 'launch-copy')}>
        Use one rerunnable script to move from <InlineCode>hello world</InlineCode> to a richer page
        without swapping tools or abandoning JSX.
      </Paragraph>
      {launchBrief.map((item) => (
        <BulletedListItem key={item} {...keyed({}, item.toLowerCase().replaceAll(' ', '-'))}>
          {item}
        </BulletedListItem>
      ))}
    </Toggle>
    <ColumnList {...keyed({}, 'artifact-columns')}>
      <Column {...keyed({ widthRatio: 0.55 }, 'artifact-left')}>
        <Heading2 {...keyed({}, 'quality-heading')}>Quality bar</Heading2>
        <ToDo {...keyed({ checked: true }, 'quality-1')}>Keep the narrative incremental.</ToDo>
        <ToDo {...keyed({ checked: true }, 'quality-2')}>Avoid browser focus hijacking.</ToDo>
        <ToDo {...keyed({ checked: true }, 'quality-3')}>Preserve evidence for every chapter.</ToDo>
      </Column>
      <Column {...keyed({ widthRatio: 0.45 }, 'artifact-right')}>
        <Heading2 {...keyed({}, 'artifact-heading')}>Validation artifacts</Heading2>
        <BulletedListItem {...keyed({}, 'artifact-1')}>Combined screenshots</BulletedListItem>
        <BulletedListItem {...keyed({}, 'artifact-2')}>Terminal sync proof</BulletedListItem>
        <BulletedListItem {...keyed({}, 'artifact-3')}>Notion API validation</BulletedListItem>
      </Column>
    </ColumnList>
    <Paragraph {...keyed({}, 'close')}>
      <Bold>Next iteration:</Bold> ship the chaptered demo runner, then polish overlays and pacing
      from the same validated foundation.
    </Paragraph>
  </Page>
)`,
  },
] satisfies readonly ManualVideoChapter[];

export const manualVideoChapters = chapters;

export const manualVideoChapterIds = manualVideoChapters.map(
  (chapter) => chapter.id,
);

const chapterById = new Map(
  manualVideoChapters.map((chapter) => [chapter.id, chapter] as const),
);

export const getManualVideoChapter = (id: string): ManualVideoChapter => {
  const chapter = chapterById.get(id);
  if (chapter === undefined) {
    throw new Error(
      `unknown chapter "${id}". Expected one of: ${manualVideoChapterIds.join(", ")}`,
    );
  }
  return chapter;
};

export const renderManualVideoSource = (
  chapter: ManualVideoChapter,
): string => {
  const usesKeyed = /\bkeyed\(/.test(chapter.sourceBody);
  const usesSyncMarker = /\bsyncMarker\b/.test(chapter.sourceBody);
  const usesStageLabel = /\bstageLabel\b/.test(chapter.sourceBody);

  const lines = [
    `import { ui${usesKeyed ? ", keyed" : ""} } from '../src/demo/manual-video/runtime.ts'`,
    "",
    `// Generated from ${chapter.id}. Edit this file live during the demo.`,
  ];

  if (usesSyncMarker === true) {
    lines.push(`const syncMarker = ${JSON.stringify(chapter.syncMarker)}`);
  }

  if (usesStageLabel === true) {
    lines.push(`const stageLabel = ${JSON.stringify(chapter.stageLabel)}`);
  }

  if (usesSyncMarker === true || usesStageLabel === true) {
    lines.push("");
  }

  lines.push(chapter.sourceBody.trim(), "");

  return lines.join("\n");
};
