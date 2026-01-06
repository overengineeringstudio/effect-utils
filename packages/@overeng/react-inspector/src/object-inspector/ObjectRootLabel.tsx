import React from 'react'
import type { FC } from 'react'

import { ObjectName } from '../object/ObjectName.tsx'
import { ObjectPreview } from './ObjectPreview.tsx'

export const ObjectRootLabel: FC<any> = ({ name, data }) => {
  if (typeof name === 'string') {
    return (
      <span>
        <ObjectName name={name} />
        <span>: </span>
        <ObjectPreview data={data} />
      </span>
    )
  } else {
    return <ObjectPreview data={data} />
  }
}
