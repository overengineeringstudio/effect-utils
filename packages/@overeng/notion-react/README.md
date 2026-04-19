# @overeng/notion-react

React component library and `react-reconciler`-based renderer that produces
Notion blocks. Write Notion pages as JSX; the renderer translates to
`NotionBlocks.append` / `update` / `delete` calls against the Notion API.

```tsx
import { Effect } from 'effect'
import { Heading1, Paragraph, Toggle, renderToNotion, sync, FsCache } from '@overeng/notion-react'

const Page = ({ items }: { items: { id: string; title: string; body: string }[] }) => (
  <>
    <Heading1>Daily</Heading1>
    {items.map((s) => (
      <Toggle key={s.id} title={s.title}>
        <Paragraph>{s.body}</Paragraph>
      </Toggle>
    ))}
  </>
)

// First-time append
const program1 = renderToNotion(<Page items={items} />, { pageId: 'page-uuid' })

// Incremental, cache-backed
const cache = FsCache.make('.notion-cache.json')
const program2 = sync(<Page items={items} />, { pageId: 'page-uuid', cache })
```

Both entry points return `Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient>`.
