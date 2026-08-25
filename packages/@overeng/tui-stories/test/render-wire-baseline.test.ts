import { Effect, Result, Schema } from 'effect'
import React from 'react'
import { describe, expect, it } from 'vitest'

import { InspectApp } from '../src/cli/renderers/InspectOutput/app.ts'
import { InspectState } from '../src/cli/renderers/InspectOutput/schema.ts'
import {
  createSimpleState,
  createWithArgsState,
} from '../src/cli/renderers/InspectOutput/stories/_fixtures.ts'
import { ListApp } from '../src/cli/renderers/ListOutput/app.ts'
import { ListState } from '../src/cli/renderers/ListOutput/schema.ts'
import { createDefaultState } from '../src/cli/renderers/ListOutput/stories/_fixtures.ts'
import { RenderApp } from '../src/cli/renderers/RenderOutput/app.ts'
import { RenderState, type RenderStateType } from '../src/cli/renderers/RenderOutput/schema.ts'
import type { CapturedStoryProps } from '../src/StoryCapture.ts'
import { renderStory } from '../src/StoryRenderer.ts'

const TestView = () => React.createElement('span')

const captured = ({
  app,
  initialState,
  timeline = [],
  command,
}: {
  readonly app: unknown
  readonly initialState: unknown
  readonly timeline?: CapturedStoryProps['timeline']
  readonly command: string
}): CapturedStoryProps => ({
  app: app as CapturedStoryProps['app'],
  View: TestView,
  initialState,
  timeline,
  command,
})

const summarizeDecodeFailure = (error: unknown) => ({
  name: error instanceof Error ? error.name : typeof error,
  message: error instanceof Error ? error.message : String(error),
})

const createRenderingState = (timelineMode: string): RenderStateType => ({
  _tag: 'Rendering',
  storyId: 'CLI/Sync/Fetch/FetchResults',
  width: 80,
  timelineMode,
})

const createErrorState = (): RenderStateType => ({
  _tag: 'Error',
  storyId: 'CLI/NonExistent/Missing',
  message: 'Story not found: "CLI/NonExistent/Missing"',
})

describe('tui-stories baselines (cross-major invariant)', () => {
  it('pins schema-encoded JSON output bytes for list and inspect surfaces', async () => {
    const listOutput = await Effect.runPromise(
      renderStory({
        captured: captured({
          app: ListApp,
          initialState: createDefaultState(),
          command: 'tui-stories list --path packages/@overeng/megarepo',
        }),
        width: 80,
        timelineMode: 'initial',
        output: 'json',
      }),
    )
    const inspectOutput = await Effect.runPromise(
      renderStory({
        captured: captured({
          app: InspectApp,
          initialState: createWithArgsState(),
          command:
            'tui-stories inspect CLI/Exec/Running/RunningVerboseParallel --path packages/@overeng/megarepo',
        }),
        width: 80,
        timelineMode: 'initial',
        output: 'json',
      }),
    )

    expect({ inspectOutput, listOutput }).toMatchInlineSnapshot(`
      {
        "inspectOutput": "{
        "id": "CLI/Exec/Running/RunningVerboseParallel",
        "title": "CLI/Exec/Running",
        "name": "RunningVerboseParallel",
        "filePath": "packages/@overeng/megarepo/src/cli/renderers/ExecOutput/stories/Running.stories.tsx",
        "args": [
          {
            "name": "height",
            "controlType": "range",
            "description": "Terminal height in pixels",
            "defaultValue": "400"
          },
          {
            "name": "interactive",
            "controlType": "boolean",
            "description": "Enable animated timeline playback",
            "defaultValue": "false"
          },
          {
            "name": "playbackSpeed",
            "controlType": "range",
            "description": "Playback speed multiplier",
            "defaultValue": "1",
            "conditional": "interactive"
          },
          {
            "name": "verbose",
            "controlType": "boolean",
            "description": "--verbose: show detailed information",
            "defaultValue": "true"
          },
          {
            "name": "mode",
            "controlType": "select",
            "description": "--mode flag",
            "defaultValue": "\\"parallel\\"",
            "options": [
              "parallel",
              "sequential"
            ]
          },
          {
            "name": "member",
            "controlType": "text",
            "description": "--member / -m flag",
            "defaultValue": "\\"\\""
          }
        ],
        "hasTimeline": true,
        "timelineEventCount": 8
      }",
        "listOutput": "{
        "groups": [
          {
            "title": "Components/StatusIcon",
            "stories": [
              {
                "name": "SuccessCheck",
                "hasTimeline": false,
                "argCount": 0
              },
              {
                "name": "ErrorCross",
                "hasTimeline": false,
                "argCount": 0
              },
              {
                "name": "ActiveSpinner",
                "hasTimeline": false,
                "argCount": 0
              }
            ]
          },
          {
            "title": "Components/Summary",
            "stories": [
              {
                "name": "AllSuccess",
                "hasTimeline": false,
                "argCount": 0
              },
              {
                "name": "WithErrors",
                "hasTimeline": false,
                "argCount": 0
              },
              {
                "name": "DryRunMode",
                "hasTimeline": false,
                "argCount": 0
              }
            ]
          },
          {
            "title": "Components/TaskItem",
            "stories": [
              {
                "name": "AllStates",
                "hasTimeline": false,
                "argCount": 0
              },
              {
                "name": "SingleActive",
                "hasTimeline": false,
                "argCount": 0
              }
            ]
          },
          {
            "title": "CLI/Status/Basic",
            "stories": [
              {
                "name": "Default",
                "hasTimeline": false,
                "argCount": 3
              },
              {
                "name": "WithErrors",
                "hasTimeline": false,
                "argCount": 3
              },
              {
                "name": "EmptyWorkspace",
                "hasTimeline": false,
                "argCount": 3
              }
            ]
          },
          {
            "title": "CLI/Exec/Running",
            "stories": [
              {
                "name": "RunningVerboseParallel",
                "hasTimeline": true,
                "argCount": 6
              },
              {
                "name": "RunningVerboseSequential",
                "hasTimeline": true,
                "argCount": 6
              }
            ]
          },
          {
            "title": "CLI/Sync/Fetch",
            "stories": [
              {
                "name": "FetchResults",
                "hasTimeline": true,
                "argCount": 8
              },
              {
                "name": "FetchNested",
                "hasTimeline": true,
                "argCount": 8
              },
              {
                "name": "FetchIssues",
                "hasTimeline": true,
                "argCount": 8
              }
            ]
          },
          {
            "title": "CLI/Add/Results",
            "stories": [
              {
                "name": "AddDefault",
                "hasTimeline": true,
                "argCount": 6
              },
              {
                "name": "AddWithSyncCloned",
                "hasTimeline": true,
                "argCount": 6
              },
              {
                "name": "AddWithSyncError",
                "hasTimeline": true,
                "argCount": 6
              }
            ]
          }
        ],
        "skippedCount": 3,
        "packagePath": "packages/@overeng/megarepo"
      }",
      }
    `)
  })

  it('pins timeline NDJSON bytes and final JSON bytes for render output', async () => {
    const renderTimeline = [
      {
        at: 0,
        action: { _tag: 'SetState', state: createRenderingState('final') },
      },
      {
        at: 250,
        action: { _tag: 'SetState', state: createErrorState() },
      },
    ] as const
    const renderCaptured = captured({
      app: RenderApp,
      initialState: createRenderingState('initial'),
      timeline: renderTimeline,
      command: 'tui-stories render CLI/NonExistent/Missing --path packages/@overeng/megarepo',
    })

    const ndjsonOutput = await Effect.runPromise(
      renderStory({
        captured: renderCaptured,
        width: 80,
        timelineMode: 'initial',
        output: 'ndjson',
      }),
    )
    const finalJsonOutput = await Effect.runPromise(
      renderStory({
        captured: renderCaptured,
        width: 80,
        timelineMode: 'final',
        output: 'json',
      }),
    )

    expect({ finalJsonOutput, ndjsonOutput }).toMatchInlineSnapshot(`
      {
        "finalJsonOutput": "{
        "_tag": "Error",
        "storyId": "CLI/NonExistent/Missing",
        "message": "Story not found: \\"CLI/NonExistent/Missing\\""
      }",
        "ndjsonOutput": "{"at":0,"state":{"_tag":"Rendering","storyId":"CLI/Sync/Fetch/FetchResults","width":80,"timelineMode":"initial"}}
      {"at":0,"action":{"_tag":"SetState","state":{"_tag":"Rendering","storyId":"CLI/Sync/Fetch/FetchResults","width":80,"timelineMode":"final"}},"state":{"_tag":"Rendering","storyId":"CLI/Sync/Fetch/FetchResults","width":80,"timelineMode":"final"}}
      {"at":250,"action":{"_tag":"SetState","state":{"_tag":"Error","storyId":"CLI/NonExistent/Missing","message":"Story not found: \\"CLI/NonExistent/Missing\\""}},"state":{"_tag":"Error","storyId":"CLI/NonExistent/Missing","message":"Story not found: \\"CLI/NonExistent/Missing\\""}}",
      }
    `)
  })

  it('pins schema decode failure partitions for durable output states', () => {
    const failures = {
      inspect: Schema.decodeUnknownResult(InspectState)({
        ...createSimpleState(),
        timelineEventCount: '0',
      }),
      list: Schema.decodeUnknownResult(ListState)({
        ...createDefaultState(),
        skippedCount: '3',
      }),
      render: Schema.decodeUnknownResult(RenderState)({
        _tag: 'Complete',
        storyId: 'CLI/Status/Basic/Default',
        width: '80',
        timelineMode: 'initial',
        renderedLines: [],
      }),
    }

    const entries = Object.entries(failures) as ReadonlyArray<readonly [string, unknown]>

    expect(
      Object.fromEntries(
        entries.map(([name, result]) => {
          const resultValue = result as Result.Result<unknown, unknown>
          if (Result.isSuccess(resultValue) === true) {
            throw new Error(`expected ${name} decode failure`)
          }
          return [name, summarizeDecodeFailure(resultValue.failure)]
        }),
      ),
    ).toMatchInlineSnapshot(`
      {
        "inspect": {
          "message": "Expected number
        at ["timelineEventCount"]",
          "name": "SchemaError",
        },
        "list": {
          "message": "Expected number
        at ["skippedCount"]",
          "name": "SchemaError",
        },
        "render": {
          "message": "Expected number
        at ["width"]",
          "name": "SchemaError",
        },
      }
    `)
  })
})
