import { describe, expect, it } from 'vitest'

import { Column, ColumnList, Page, Paragraph } from '../components/blocks.ts'
import { createNotionRoot } from './host-config.ts'
import { OpBuffer } from './op-buffer.ts'
import { ATOMIC_CONTAINERS, indexChildren, nestedBody } from './render-to-notion.ts'

describe('render-to-notion atomic-container handling', () => {
  it('marks column_list as atomic', () => {
    expect(ATOMIC_CONTAINERS.has('column_list')).toBe(true)
  })

  it('marks table as atomic (rows must ship inlined, same contract as column_list)', () => {
    expect(ATOMIC_CONTAINERS.has('table')).toBe(true)
  })

  it('builds a nested body for ColumnList+Column+Paragraph so a single API call carries the full tree', () => {
    const buffer = new OpBuffer('root')
    const root = createNotionRoot(buffer, 'root')
    root.render(
      <Page>
        <ColumnList>
          <Column>
            <Paragraph>left</Paragraph>
          </Column>
          <Column>
            <Paragraph>right</Paragraph>
          </Column>
        </ColumnList>
      </Page>,
    )

    const appendOps = buffer.ops.flatMap((o) => (o.kind === 'append' ? [o] : []))
    const columnListOp = appendOps.find((o) => o.type === 'column_list')
    expect(columnListOp).toBeDefined()

    const index = indexChildren(buffer.ops)
    const body = nestedBody(columnListOp!, index) as {
      object: string
      type: string
      column_list: {
        children: readonly {
          type: string
          column: {
            children: readonly { type: string; paragraph: { rich_text: readonly unknown[] } }[]
          }
        }[]
      }
    }

    expect(body.object).toBe('block')
    expect(body.type).toBe('column_list')
    expect(body.column_list.children).toHaveLength(2)
    const [leftCol, rightCol] = body.column_list.children
    expect(leftCol!.type).toBe('column')
    expect(rightCol!.type).toBe('column')
    expect(leftCol!.column.children).toHaveLength(1)
    expect(leftCol!.column.children[0]!.type).toBe('paragraph')
    const leftRT = leftCol!.column.children[0]!.paragraph.rich_text[0] as {
      text: { content: string }
    }
    expect(leftRT.text.content).toBe('left')
    const rightRT = rightCol!.column.children[0]!.paragraph.rich_text[0] as {
      text: { content: string }
    }
    expect(rightRT.text.content).toBe('right')
  })
})
