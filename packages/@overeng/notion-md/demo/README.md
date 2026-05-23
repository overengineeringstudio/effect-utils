# notion-md Demo Fixture

`showcase.nmd` is the local side of the durable automated demo page:

https://www.notion.so/overeng-notion-md-demo-automated-369f141b18dc80e4850cff344ad5b48e

Use it as a real 1:1 sync fixture:

```sh
export NOTION_TOKEN="secret_..."
notion-md status packages/@overeng/notion-md/demo/showcase.nmd
notion-md sync packages/@overeng/notion-md/demo/showcase.nmd
```

The committed `.notion-md/objects` entry is part of the fixture. It contains
the last clean base snapshot used for status, merge planning, and conflict
evidence.
