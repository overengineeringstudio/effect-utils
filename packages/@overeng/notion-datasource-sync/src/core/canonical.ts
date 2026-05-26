import { Schema } from 'effect'

import { hashStoreBytes } from '../store/projections.ts'
import type { QueryRowsInput } from './commands.ts'
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

const stableStringify = (value: unknown): string => {
  if (value === undefined) {
    return '"[undefined]"'
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  ) {
    return stableStringify(value.toJSON())
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(value)
}

export const queryContractHash = (input: QueryRowsInput, apiVersion: string) =>
  hashStoreBytes(
    stableStringify({
      apiVersion,
      dataSourceId: input.dataSourceId,
      queryContract: {
        apiVersion: input.queryContract.apiVersion,
        filter: input.queryContract.filter,
        highWatermark: input.queryContract.highWatermark,
        membershipScope: input.queryContract.membershipScope,
        pageSize: input.queryContract.pageSize,
        sorts: input.queryContract.sorts,
      },
    }),
  )
