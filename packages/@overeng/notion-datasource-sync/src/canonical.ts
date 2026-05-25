import { Schema } from 'effect'

import type { DataSourceId, PageId, PropertyId } from './domain.ts'
import { SurfaceKey } from './events.ts'

export const surfaceKey = (value: string): SurfaceKey => Schema.decodeUnknownSync(SurfaceKey)(value)

export const pageSurfaceKey = (pageId: PageId): SurfaceKey => surfaceKey(`page:${pageId}`)

export const propertySurfaceKey = (pageId: PageId, propertyId: PropertyId): SurfaceKey =>
  surfaceKey(`page:${pageId}:property:${propertyId}`)

export const bodySurfaceKey = (pageId: PageId): SurfaceKey => surfaceKey(`page:${pageId}:body`)

export const schemaSurfaceKey = (dataSourceId: DataSourceId, propertyId: PropertyId): SurfaceKey =>
  surfaceKey(`data-source:${dataSourceId}:schema:${propertyId}`)

export const pathSurfaceKey = (path: string): SurfaceKey => surfaceKey(`path:${path}`)

export const querySurfaceKey = (
  dataSourceId: DataSourceId,
  queryContractHash: string,
): SurfaceKey => surfaceKey(`data-source:${dataSourceId}:query:${queryContractHash}`)
