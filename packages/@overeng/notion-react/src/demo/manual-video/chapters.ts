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
  readonly expectedApiTexts: readonly string[];
  readonly expectedBrowserTexts: readonly string[];
  readonly sourceBody: string;
};

const chapters = [
  {
    id: "chapter-1-hello-world",
    title: "Chapter 1 - Hello World",
    beatRange: "00:00-00:12",
    goal: "Establish the core loop with a tiny, legible page.",
    syncMarker: "manual-demo-v1",
    stageLabel: "stage-1: hello world",
    overlayTitle: "Hello world",
    overlayBody: "A minimal JSX file syncs into a real Notion page.",
    expectedApiTexts: [
      "Live sync demo",
      "Sync marker: manual-demo-v1",
      "Source of truth: JSX in tmux. Target: Notion page body.",
    ],
    expectedBrowserTexts: ["Live sync demo", "Sync marker: manual-demo-v1"],
    sourceBody: String.raw`
const { Page, Heading1, Paragraph, Callout, Bold, InlineCode } = ui

return (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      Source of truth: <Bold>JSX in tmux</Bold>. Target: <Bold>Notion page body</Bold>.
    </Paragraph>
    <Callout {...keyed({ icon: '🧪', color: 'blue_background' }, 'status')}>
      Sync marker: {syncMarker}
    </Callout>
    <Paragraph {...keyed({}, 'instructions')}>
      Start with <InlineCode>{stageLabel}</InlineCode>, then grow the page block-by-block instead
      of jumping into a large pre-existing example.
    </Paragraph>
  </Page>
)`,
  },
  {
    id: "chapter-2-marker-bump",
    title: "Chapter 2 - First Visible Mutation",
    beatRange: "00:12-00:22",
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
const { Page, Heading1, Paragraph, Callout, Bold, InlineCode } = ui

return (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      Source of truth: <Bold>JSX in tmux</Bold>. Target: <Bold>Notion page body</Bold>.
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
    beatRange: "00:22-00:40",
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
const { Page, Heading1, Heading2, Paragraph, Callout, BulletedListItem, ToDo, Bold } = ui

return (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      We start simple, then grow a page that feels like a real working document.
    </Paragraph>
    <Callout {...keyed({ icon: '🚀', color: 'green_background' }, 'status')}>
      Sync marker: {syncMarker}. JSX stays the source of truth while Notion remains the review surface.
    </Callout>
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
    <Paragraph {...keyed({}, 'footer')}>
      This chapter is still compact, but it already reads like a <Bold>real document</Bold> instead
      of a single paragraph.
    </Paragraph>
  </Page>
)`,
  },
  {
    id: "chapter-4-refactor",
    title: "Chapter 4 - Refactor, Don’t Just Append",
    beatRange: "00:40-00:58",
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
const { Page, Heading1, Heading2, Paragraph, Callout, BulletedListItem, ToDo, Bold, InlineCode } =
  ui

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

return (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      We start simple, then grow a page that feels like a real working document.
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
    <Paragraph {...keyed({}, 'footer')}>
      This is the same idea as any normal React refactor: better structure, same outcome, easier to
      extend.
    </Paragraph>
    <Paragraph {...keyed({}, 'marker')}>
      <Bold>Sync marker:</Bold> {syncMarker}
    </Paragraph>
  </Page>
)`,
  },
  {
    id: "chapter-5-rich-page",
    title: "Chapter 5 - Credible End State",
    beatRange: "00:58-01:15",
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

return (
  <Page>
    <Heading1 {...keyed({}, 'title')}>Live sync demo</Heading1>
    <Paragraph {...keyed({}, 'summary')}>
      The same JSX file now drives a richer hierarchical Notion page without leaving the normal
      React authoring model.
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
        <Heading2 {...keyed({}, 'artifact-heading')}>Artifacts</Heading2>
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

const indent = (value: string, spaces: number): string => {
  const prefix = " ".repeat(spaces);
  return value
    .trim()
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
};

export const renderManualVideoSource = (
  chapter: ManualVideoChapter,
): string => `import * as path from 'node:path'

import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import type { ReactElement } from 'react'

import { NotionConfig } from '@overeng/notion-effect-client'

import { FsCache } from '../src/cache/mod.ts'
import * as Host from '../src/components/mod.ts'
import type { DemoUi } from '../src/demo/page-demos.tsx'
import { sync } from '../src/renderer/mod.ts'

const DEFAULT_PAGE_ID = '${MANUAL_VIDEO_DEFAULT_PAGE_ID}'
const CACHE_KEY = 'notion-video-manual-demo'

// Generated from ${chapter.id}. Edit this file live during the demo.
const syncMarker = ${JSON.stringify(chapter.syncMarker)}
const stageLabel = ${JSON.stringify(chapter.stageLabel)}

const keyed = <T extends object>(
  props: T,
  blockKey: string,
): T & { readonly blockKey: string } => ({
  ...props,
  blockKey,
})

const renderManualDemo = (ui: DemoUi): ReactElement => {
${indent(chapter.sourceBody, 2)}
}

const notionToken = process.env.NOTION_TOKEN
if (!notionToken) {
  throw new Error('NOTION_TOKEN is required')
}

const pageId = (process.argv[2] ?? process.env.NOTION_DEMO_PAGE_ID ?? DEFAULT_PAGE_ID).trim()

const layer = Layer.mergeAll(
  Layer.succeed(NotionConfig, {
    authToken: Redacted.make(notionToken),
    retryEnabled: true,
    maxRetries: 5,
    retryBaseDelay: 1000,
  }),
  FetchHttpClient.layer,
)

await Effect.runPromise(
  sync(renderManualDemo(Host), {
    pageId,
    cache: FsCache.make(
      path.join(process.cwd(), 'tmp', 'notion-demo-cache', \`\${CACHE_KEY}.\${pageId}.json\`),
    ),
  }).pipe(Effect.provide(layer)),
)
`;
