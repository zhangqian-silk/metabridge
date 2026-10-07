# Narrow CPA compaction compatibility

Ordinary CPA Responses traffic remains passthrough. Add this optional policy to
the metabridge CPA provider file, not CPA's own server configuration:

```json
"compaction": {
  "mode": "local",
  "models": [
    { "regex": "^factory/claude-" },
    { "regex": "^fusecode/claude-" }
  ],
  "stripImages": true
}
```

Explicit `{ "mode": "passthrough" }` disables local compaction. With `via: "cpa"`
or `via: "direct"`, an absent policy defaults to passthrough too. Old files without
`via` retain legacy prefix-based adaptation. Local policy works on either chain.
Omit `models` to apply local compaction to the entire provider. Models accept exact IDs or the existing
`{regex, flags}` matcher format. It applies only to Responses providers, never
official `codex-subscription` providers. Keep Factory's full CPA model IDs.

For matching models, `compaction_trigger` becomes a normal summary request sent
through CPA to the same model. Only this request replaces historical image blocks
with explicit placeholders and removes tool definitions and the trigger.
Existing textual image analysis is retained; unrecorded visual details are not.
No request-size limit, model fallback, additional agent or new service is added.

Only complete, non-truncated summaries become `mb-cmp1` checkpoints. On subsequent
requests for these models, the bridge converts its checkpoint into an assistant
historical summary and keeps newer messages/tool items. Opaque or malformed
checkpoints fail explicitly rather than being silently discarded.

Other models and ordinary requests without checkpoints remain passthrough.
FuseCode Claude uses the same summary/checkpoint adapter: CPA translates the
ordinary summary request to Claude Messages, while metabridge produces the
compaction item Codex expects. CPA protocol translation alone does not produce
a Codex compaction checkpoint.
No legacy sanitization, tool renaming or reasoning transformations are enabled.
Global `compactionStripImages` retains its legacy behavior; this per-model
policy uses its own `stripImages` setting.

After changing the provider file, restart `metabridge.service`.
Rollback by removing this policy and restarting. Threads already containing
`mb-cmp1` checkpoints still require this replay adapter, or a new conversation;
do not disable it mid-thread expecting CPA to understand those checkpoints.

Verification:
`npm test` covers scoping, large historical images, summary failure and checkpoint
replay. For an explicit live replay of an existing failed compaction request:
`node scripts/verify-cpa-compaction.js --allow-inference /absolute/path/to/CPA-error.log`.
This sends that history to the same model through the existing CPA route, then
checks a new tool-call/result round trip after the checkpoint. It prints no
transcript or credentials; its private checkpoint artifact is saved with mode 0600.
