# Runtime state and repository documentation

- Repository documentation describes reusable interfaces, configuration semantics,
  setup procedures, examples and verification methods. It is not a deployment log.
- For account/key changes, model filters, service ports, routing strategy, session
  affinity/TTL, quota observations or local verification outcomes, edit only the
  relevant private runtime configuration. Do not update repository docs or example
  defaults just to mirror this machine's state.
- When a local deployment note is useful or requested, store it under
  `~/.metabridge/docs/`, never repository `docs/`. Use
  `node scripts/write-runtime-note.js <name> < /absolute/path/to/note.md`;
  replacing an existing note requires `--replace` and retains a private backup.
- Notes must not contain API keys, tokens, management passwords, raw credential
  files or unnecessary account identity information.
- Document changes to reusable behavior in repository docs when implementing that
  behavior. Preserve private configs and credentials; config-only operations do
  not authorize unrelated repository edits or service behavior changes.
