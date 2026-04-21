import type { Meta, StoryObj } from '@storybook/react'

import type { DemoContext } from '../../demo/page-demos.tsx'
import { storybookSyncPages } from '../../demo/storybook-sync-catalog.tsx'
import * as Web from '../mod.ts'

const SHARED_DEMO_PAGE_IDS = new Map(
  storybookSyncPages.map((page, index) => [
    page.slug,
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  ]),
)

const sharedDemoContext: DemoContext = {
  parentPageId: '00000000-0000-4000-8000-999999999999',
  pageIdsBySlug: SHARED_DEMO_PAGE_IDS,
}

const sharedDemoBySlug = new Map(
  storybookSyncPages
    .filter(
      (
        page,
      ): page is (typeof storybookSyncPages)[number] & {
        readonly render: NonNullable<(typeof page)['render']>
      } => page.render !== undefined,
    )
    .map((page) => [page.slug, page]),
)

export const sharedDemoMeta = (title: string) =>
  ({
    title,
    parameters: { layout: 'fullscreen' },
  }) satisfies Meta

export const sharedDemoStory = (slug: string): StoryObj => {
  const page = sharedDemoBySlug.get(slug)
  if (page === undefined) {
    throw new Error(`No shared demo page registered for slug: ${slug}`)
  }

  return {
    render: () => page.render(Web, sharedDemoContext),
  }
}
