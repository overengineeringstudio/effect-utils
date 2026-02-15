import React from 'react'
import type { FC } from 'react'

import { ObjectValue } from '../object/ObjectValue.tsx'
import { useStyles } from '../styles/index.tsx'
import { hasOwnProperty } from '../utils/objectPrototype.tsx'

export const DataContainer: FC<{
  rows: (string | number)[]
  columns: string[]
  rowsData: unknown[]
}> = ({ rows, columns, rowsData }) => {
  const styles = useStyles('TableInspectorDataContainer')
  const borderStyles = useStyles('TableInspectorLeftBorder')

  return (
    <div style={styles.div}>
      <table style={styles.table}>
        <colgroup />
        <tbody>
          {rows.map((row, i) => (
            <tr key={row} style={styles.tr}>
              <td style={{ ...styles.td, ...borderStyles.none }}>{row}</td>

              {columns.map((column) => {
                const rowData = rowsData[i]
                // rowData could be
                //  object -> index by key
                //    array -> index by array index
                //    null -> pass
                //  boolean -> pass
                //  string -> pass (hasOwnProperty returns true for [0..len-1])
                //  number -> pass
                //  function -> pass
                //  symbol
                //  undefined -> pass
                if (
                  typeof rowData === 'object' &&
                  rowData !== null &&
                  hasOwnProperty.call(rowData, column) === true
                ) {
                  return (
                    <td key={column} style={{ ...styles.td, ...borderStyles.solid }}>
                      <ObjectValue object={(rowData as Record<string, unknown>)[column]} />
                    </td>
                  )
                } else {
                  return <td key={column} style={{ ...styles.td, ...borderStyles.solid }} />
                }
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
