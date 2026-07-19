import { type SchemaInfo, getSchemaInfo } from '../src/schema/effectSchema.tsx'
import * as Lineage from '../src/schema/lineage.ts'

const schema = {
  ast: {
    _tag: 'String',
    annotations: {
      '@overeng/lineage': { _tag: 'SourceOfTruth' },
      '@overeng/authority': { writers: [] },
      '@overeng/freshness': {},
      '@overeng/reference': { _tag: 'ForeignKey', targetSchema: 'Consumer.Record' },
    },
  },
}

const schemaInfo: SchemaInfo = getSchemaInfo(schema)
const lineage: Lineage.Lineage | undefined = Lineage.getLineage(schema)
const authority: Lineage.Authority | undefined = Lineage.getAuthority(schema)
const freshness: Lineage.Freshness | undefined = Lineage.getFreshness(schema)
const reference: Lineage.Reference | undefined = Lineage.getReference(schema)

void [schemaInfo, lineage, authority, freshness, reference]
