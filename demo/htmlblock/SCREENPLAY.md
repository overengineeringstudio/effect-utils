# notion html block — Screenplay

Gap: Notion can embed a live web page, but only if you already host it somewhere — there's no way to hand Notion a raw HTML file and have it render as an interactive block. Wow: two terminal commands — upload a local `.html`, then append one `embed` block — and Notion renders it live, JS and all, sandboxed in the page. No hosting, no iframe URL, no copy-paste. ~2 min.

## Backstage (before recording — not on camera)

- `devenv shell`
- `export DEMO_PARENT_PAGE=<demo parent page id>`   # a page the ntn integration can write to
- Sanity check auth: `ntn api v1/users/me | jq -r '.name'`
- Have `demo/htmlblock/artifact.html` on disk (a tiny self-contained page with a live clock + click counter).
- Open the parent page in the browser next to the terminal.

Layout: terminal on the left, the Notion page on the right.

## On camera (copy-paste in order)

### Beat 0 — Show the artifact   say: "Here's a plain HTML file on my laptop. Live clock, a button, real JavaScript — nothing hosted anywhere."

```
open demo/htmlblock/artifact.html
```

It opens in the browser: the counter ticks, the button counts clicks. This is just a local file.

### Beat 1 — Upload it to Notion   say: "First command: I hand the raw bytes to Notion's File Upload API. It gives me back an id."

```
FILE_ID=$(ntn files create --filename artifact.html --content-type text/html --plain \
  < demo/htmlblock/artifact.html | cut -f1)
echo "$FILE_ID"
```

Prints a UUID — that's the uploaded file, sitting in Notion, not yet on any page.

### Beat 2 — Embed it as a block   say: "Second command: I append one block to the page — an embed backed by that upload. Watch the page."

```
ntn api "/v1/blocks/$DEMO_PARENT_PAGE/children" -X PATCH \
  -d "{\"children\":[{\"type\":\"embed\",\"embed\":{\"type\":\"file_upload\",\"file_upload\":{\"id\":\"$FILE_ID\"}}}]}"
```

Within a second the block appears on the Notion page — the clock is ticking and the button counts clicks, **inside Notion**. It's sandboxed and interactive: not a screenshot, not a link.

### Beat 3 — Prove it's a real block   say: "And it's a first-class block — here it is in the page's block tree."

```
ntn api "/v1/blocks/$DEMO_PARENT_PAGE/children" | jq '.results[] | select(.type=="embed") | .embed.type'
```

Prints `"file_upload"`. That's the whole trick — and `demo/explainers/embed.sh` wraps these same two calls (with 429 backoff) so any polished explainer HTML becomes a hero visual on its page.
