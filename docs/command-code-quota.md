# Command Code account quota in CPA

The existing `factory-quota` CPA read-only plugin also supports Command Code.
Its additional management route is:

```text
GET /v0/management/plugins/factory-quota/command-code
```

CPA enforces management authentication. The plugin reads the private
`~/.config/cliproxyapi/config.json` file and selects only the uniquely named
`command-code` OpenAI-compatible provider with the canonical base URL
`https://api.commandcode.ai/provider/v1` and exactly one API key. Multiple
providers/keys fail explicitly rather than report a potentially different
account. No browser-supplied URL or credential is used.

Read-only upstream requests use Bearer authentication, reject redirects, apply
a shared 25-second deadline and bounded JSON reads:

- `/alpha/whoami` establishes organization scope; failure stops the query.
- `/alpha/billing/credits?orgId=...` returns rolling windows and credit pools.
- `/alpha/billing/subscriptions?orgId=...` optionally supplies period end.

The query follows the endpoint/schema used in the locally inspected OpenCodex
`src/providers/quota/vendor-probes-key.ts`, and was verified against Command Code.
This is an alpha billing interface, not a guaranteed public stable API.

The card displays 5-hour/weekly remaining percentages and used/cap values,
monthly/purchased/free USD balances, and a total only when all pools are known.
Zero reset timestamps mean unknown. Subscription period end is displayed
separately; it is not a rolling reset or purchased-credit expiry. Lifetime spend
is not mixed with current-cycle balances to invent a usage percentage.

Only normalized quota data is returned, never the API key or account IDs.
There is no inference request, background polling or model routing change.
Failed refreshes clear the previous result instead of presenting stale data
as current, and requests are isolated when the management connection changes.

Build and install through the existing Factory quota plugin/UI workflow in
`docs/factory-api.md`; the overlay includes both cards. Rebuild the shared
library and management HTML together, then restart only `cliproxyapi.service`.
The installer retains configuration, plugin and HTML backups, and keeps panel
auto-update disabled so the upstream panel cannot overwrite these cards.
