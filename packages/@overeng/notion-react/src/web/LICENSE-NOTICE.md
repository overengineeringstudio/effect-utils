# Third-party attribution

`vendored-notion.css` in this directory is derived from the
[`react-notion-x`](https://github.com/NotionX/react-notion-x) project by
Travis Fischer and contributors, licensed under the MIT License.

- Upstream repo: https://github.com/NotionX/react-notion-x
- Upstream file: `packages/react-notion-x/src/styles.css`
- Upstream version: `v7.10.0` (npm)
- Upstream commit touching this file: `c1b4260c736b5dc3376fd278a2fc49ae6e81a916` (2026-03-30)

See `PRUNING.md` for the derivative modifications we apply (pruned sections
we do not render, rescoped `:root` tokens onto `.notion-page`).

## DOM patterns and SVG icons in `blocks.tsx` / `inline.tsx`

Component DOM structures (callout nesting, to-do checkbox markup,
toggleable-header `<details>` wrapping, heading inner `notion-h-title`
span, color-class naming) are modelled after react-notion-x's
`packages/react-notion-x/src/block.tsx` and `components/checkbox.tsx`
under the same MIT license. The inline `CheckSvg` in `blocks.tsx` is
copied from `react-notion-x/src/icons/check.tsx`.

Upstream version: `v7.10.0` (npm) / commit `c1b4260c`.

See `context/notion-react-visual-parity/{analysis,design-decisions}.md`
for the gap analysis and adoption rationale.

## Original license

```
MIT License

Copyright (c) 2020 Travis Fischer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
