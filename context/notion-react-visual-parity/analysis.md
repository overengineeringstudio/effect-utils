# DOM gap analysis: `@overeng/notion-react/web` vs `react-notion-x`

Source studied: `react-notion-x@v7.10.0` (commit `c1b4260c`) — primarily
`packages/react-notion-x/src/block.tsx`, `components/checkbox.tsx`,
`components/page-icon.tsx`, `icons/check.tsx`, `styles.css`.

Local components: `packages/@overeng/notion-react/src/web/{blocks,inline}.tsx`.

Vendored CSS targets the rnx DOM contract. Where our DOM diverges from rnx,
their CSS rules either no-op or apply to the wrong element — the visible
"tiny grey ▸ vs chunkier chevron" gap is a symptom, not the only divergence.

## Block-level

| Block | rnx DOM | Our DOM | Gap (visible / functional) |
|---|---|---|---|
| paragraph (`text`) | `<div class="notion-text">…<div class="notion-text-children"/></div>` | `<p class="notion-text">…</p>` | `<p>` collapses adjacent margins differently from `<div>`; rnx CSS targets descendant selectors so it works either way, but spec-fidelity wants `<div>` |
| header / sub_header / … | `<h2..h5 class="notion-h notion-h{n}"><span><div class="notion-header-anchor"/><a class="notion-hash-link"><LinkIcon/></a><span class="notion-h-title"><Text/></span></span></h{n}>` | `<h{n} class="notion-h notion-h{n}">{children}</h{n}>` | Missing `notion-h-title` span (vendored CSS targets it for color/weight); missing anchor + hash link (cosmetic, hover-link is dead). rnx demotes h1→`<h2>`; we keep `<h1>` (we have no page title above us — keep current semantics) |
| toggleable header | `<details class="notion-toggle"><summary>{headerBlock}</summary><div>{children}</div></details>` | `<details class="notion-toggle-heading notion-toggle-heading-{n}"><summary><h{n}/></summary></details>` | **Bug**: children dropped (no body div). Class doesn't match vendored CSS (`notion-toggle`). Our custom `::before '▸'` overrides browser native disclosure marker — looks worse than rnx which lets the native marker render |
| toggle | `<details class="notion-toggle"><summary><Text/></summary><div>{children}</div></details>` | `<details class="notion-toggle"><summary>{title}</summary><div class="notion-toggle-body">{children}</div></details>` | Inner div has extra class `notion-toggle-body` that rnx vendored CSS doesn't know — falls outside `.notion-toggle > div` rule; chevron same regression as above |
| bulleted_list / numbered_list | One `<ul>`/`<ol>` wrapping all `<li>` siblings of same type | Each item rendered standalone as `<ul><li/></ul>` (reconciler-driven) | Vertical rhythm broken — each bullet sits in its own block-level container with `margin: 6px 0`. List-numbering also restarts per item. Tracked as separate concern (#62) but worth noting |
| to_do | `<div class="notion-to-do"><div class="notion-to-do-item"><span class="notion-property notion-property-checkbox"><div class="notion-property-checkbox-{checked,unchecked}">[<CheckSvg/>]</div></span><div class="notion-to-do-body [notion-to-do-checked]"><Text/></div></div><div class="notion-to-do-children">{children}</div></div>` | `<div class="notion-to-do [notion-to-do-checked]"><div class="notion-to-do-item"><input type="checkbox"/><div class="notion-to-do-body">{children}</div></div></div>` | Native `<input>` ignores all rnx checkbox styling (`.notion-property-checkbox{,-checked,-unchecked}`); strike-through targets wrong element (we put it on the outer wrapper, rnx puts it on `.notion-to-do-body`); no children slot |
| callout | `<div class="notion-callout [notion-{color}_co]"><PageIcon class="notion-page-icon-inline"/><div class="notion-callout-text"><Text/>{children}</div></div>` | `<aside class="notion-callout [notion-{color}]" role="note"><span class="notion-callout-icon">{icon}</span><div class="notion-callout-text">{children}</div></aside>` | `<aside>` styles differently in some resets; `.notion-callout-icon` not in vendored CSS so icon has no `align-self/width/height/font-size`; color suffix wrong (`_co` vs base) so background-color rules don't apply |
| quote | `<blockquote class="notion-quote">…</blockquote>` | same | OK |
| code | `<pre class="notion-code"><code>{src}</code></pre>` | same (with `data-language`) | OK |
| divider | `<hr class="notion-hr"/>` | same | OK |
| table | `<table class="notion-simple-table"><tbody>{rows}</tbody></table>` | `<div class="notion-simple-table-wrap"><table class="notion-simple-table"><tbody>{rows}</tbody></table></div>` | Extra wrapper for horizontal scroll — pragmatic divergence we keep; rnx wraps via parent block. Worth keeping |
| table_row / cell | `<tr class="notion-simple-table-row">{<td class="notion-simple-table-cell"/>…}</tr>` | `<tr class="notion-simple-table-row">{children}</tr>` | Cells emitted by caller — assume already correct |
| child_page | `<PageLink class="notion-page-link"><PageTitle><PageIcon/>{title}</PageTitle></PageLink>` | `<div class="notion-child-page"><span class="notion-child-page-icon">📄</span><span>{title}</span></div>` | Different idiom — we don't have a router; keep as plain div but make class `notion-page-link` for CSS parity |
| equation | `<div class="notion-equation notion-equation-block">…</div>` (KaTeX) | `<pre class="notion-equation-block"><code>…</code></pre>` | Acceptable divergence (no KaTeX dep) |
| bookmark / embed / media | rnx has rich asset wrapper | ours is minimal | Acceptable — out of scope for this pass |

## Inline

| Inline | rnx DOM | Our DOM | Gap |
|---|---|---|---|
| text/bold/italic/strike/underline | plain semantic tags | same | OK |
| inline code | `<code class="notion-inline-code">…</code>` | same | OK |
| color | `<span class="notion-{color}">` | same shape (we use `notion-color-{c}` / `notion-bg-{c}`) | rnx uses `notion-{color}` for fg and `notion-{color}_background` (verbatim) for bg. Vendored CSS targets the rnx form — we should match |
| link | `<a class="notion-link" href>` | same | OK |
| mention | varies (date / user / page chips) | stub `<span class="notion-mention">@…</span>` | Stub OK for v0.1 |
| inline equation | KaTeX `<span>` | `<code class="notion-equation">…</code>` | Acceptable divergence |

## Top-5 highest-impact gaps (drives this PR)

1. Toggleable headings drop children entirely (bug) and use a non-vendored class
2. Custom `::before '▸'` chevron CSS replaces the native disclosure marker
   (the visible regression that prompted this work)
3. Callout uses `<aside>`, wrong icon class, wrong color suffix → vendored
   CSS does not apply
4. To-do uses native `<input type="checkbox">` instead of rnx's
   `<span class="notion-property-checkbox">…<CheckSvg/>…</span>` markup
5. Inline color uses our own `notion-color-{c}` / `notion-bg-{c}` naming
   instead of rnx's `notion-{c}` / `notion-{c}_background`
