import React from 'react'
import type { FC } from 'react'

import { themeAcceptor } from '../styles/index.tsx'
import { TreeView } from '../tree-view/TreeView.tsx'
import { DOMNodePreview } from './DOMNodePreview.tsx'
import { shouldInline } from './shouldInline.tsx'

const domIterator = function* (data: any) {
  if (data !== undefined && data.childNodes !== undefined) {
    const textInlined = shouldInline(data)

    if (textInlined === true) {
      return
    }

    for (let i = 0; i < data.childNodes.length; i++) {
      const node = data.childNodes[i]

      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim().length === 0) continue

      yield {
        name: `${node.tagName}[${i}]`,
        data: node,
      }
    }

    // at least 1 child node
    if (data.tagName !== undefined) {
      yield {
        name: 'CLOSE_TAG',
        data: {
          tagName: data.tagName,
        },
        isCloseTag: true,
      }
    }
  }
}

const DOMInspector: FC<any> = (props) => {
  return <TreeView nodeRenderer={DOMNodePreview} dataIterator={domIterator} {...props} />
}

// DOMInspector.propTypes = {
//   // The DOM Node to inspect
//   data: PropTypes.object.isRequired,
// };

const themedDOMInspector = themeAcceptor(DOMInspector)

export { themedDOMInspector as DOMInspector }
