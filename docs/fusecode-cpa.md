# FuseCode Claude via CPA

Path: Codex Responses → metabridge → CPA native Claude translator → FuseCode `/v1/messages`.
No Droid/Claude Code agent is launched.

Run `node scripts/configure-fusecode-cpa.js --activate` with network proxy settings appropriate to this host.
The script reads `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` from the user's
`~/.claude/settings.json` file, discovers Claude IDs with an authenticated `/v1/models` request,
and merges only the named `fusecode` Claude provider into the existing CPA JSON configuration.
Supported HTTPS origins are `www.fusecode.ai` and `www.fusecode.cc`; it uses the configured origin.
Both saved configuration and backup have mode 0600. No credential is printed.
Claude Code settings, other CPA providers, management settings and plugins are retained.

Restart `cliproxyapi.service` and `metabridge.service`, then run the existing catalog sync.
Ensure the metabridge CPA provider's `compaction.models` also includes
`{"regex":"^fusecode/claude-"}` with `mode: "local"` and `stripImages: true`.
See `docs/cpa-compaction.md`. Without this policy, ordinary inference can succeed
but Codex remote compaction fails because Claude returns no compaction item.
Model routing IDs are `fusecode/<upstream-id>`; display names are `fusecode · <upstream-id>`.
Restart the Codex client to load the updated catalog. Existing official models remain selectable.

Bounded live verification:
`node scripts/verify-factory-codex.js --allow-inference fusecode/claude-sonnet-5-5`.
The optional `--allow-unsandboxed-test` is only for a host where Codex's read-only
sandbox cannot start; it does not alter the user's global configuration.
This checks one private fixture read and the final answer, not just model discovery.
Catalog inclusion does not prove availability or compatibility of every listed model.
FuseCode billing/quota integration is not provided by this configuration.
