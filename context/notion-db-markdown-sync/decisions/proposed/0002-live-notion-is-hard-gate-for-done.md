# Live Notion (L6) is a hard gate for "done"; harness is unblocked

Status: proposed

"Done" for PR #775 requires L6 live Notion tests covering schema drift, relation
completeness, files/comments capability, and read-after-write settlement. These
semantics cannot be proven by fakes alone — they are exactly the live-only surface
that the VRS's core safety claims (proof-based mutation, relation completeness,
settlement) depend on.

The harness is confirmed unblocked. The Notion token resolves via
`op://ialr3ed3depgv523r3bqojsyjq/mtvtayqbsvdt6yuniutk7t4bfe/u7q2coiqw5wdt4ab33yia3g4w4`
(1Password item "Notion" → field "Effect API test env integration token").
The integration has dedicated accessible scratch parents:
`@overeng/notion-datasource-sync e2e tests` page
`36bf141b-18dc-8097-898d-c419155cba02` and `@overeng/notion-effect-client API
test env` page `2dbf141b-18dc-8133-b921-c786d2b00ecf`, plus a `notion-md e2e
run ledger` page. The existing harness already reads `NOTION_API_TOKEN`,
`NOTION_TEST_PARENT_PAGE_ID`, and `NOTION_DATASOURCE_SYNC_PARENT_PAGE_ID`, with
allowlist + cleanup-ledger guards and `NOTION_MD_LIVE_REQUIRED=1` /
`NOTION_DATASOURCE_SYNC_LIVE=1` opt-in gates. Tokens are session-injected via
env at test time (never written to files or commits).

## Considered Options

| Option                                                                                   | Result   | Reason                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| L6 live mandatory for done; run autonomously against the synthetic allowlisted workspace | Selected | Fakes cannot prove Notion API semantics; the VRS's core safety claims are exactly the live-only surface. Harness is confirmed unblocked. |
| Accept L0–L5 + L7 green and defer live to human                                          | Rejected | Fakes cannot prove schema drift, relation completeness, files/comments capability, or read-after-write settlement.                       |

## Consequences

If a new live scenario requires a parent page the integration cannot reach, that
scenario becomes a ratification-gated TODO rather than blocking the milestone. It
must be documented as a gap, not silently dropped (see D7).
