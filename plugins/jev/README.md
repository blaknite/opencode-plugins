# Jev decision tool

This global OpenCode plugin provides `jev_evaluate` to any tool-capable model and adds delegation guidance to agent-loop requests. It sends only the state and questions supplied to the tool, never the session transcript automatically.

## Connect

Create an API key at https://console.typesafe.ai/keys. For persistent setup, run this in a local zsh terminal. It stores the key in a file readable only by your user, without echoing it or putting it in shell history:

```sh
(
  umask 077
  credentials="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/credentials"
  mkdir -p "$credentials" && chmod 700 "$credentials" || exit 1
  read -rs 'jev_key?TypeSafe API key: '; printf '\n'
  [[ -n "$jev_key" ]] || exit 1
  printf '%s' "$jev_key" > "$credentials/jev-api-key"
  chmod 600 "$credentials/jev-api-key"
)
```

The plugin reads this file on every call, so no service restart is needed to add or rotate the key. The key is stored as plaintext protected by filesystem permissions, not encrypted. Keep it out of backups or sync destinations you do not trust. The `credentials/` directory is ignored by Git.

Alternatively, set `TYPESAFE_API_KEY` in the service environment. A nonblank environment value overrides the file. Do not put the raw key into source files, OpenCode configuration, or chat.

Then ask OpenCode: “Use Jev to choose between these two options, based on this evidence.” A missing key produces a clear error rather than a fabricated decision.

## Behavior

- Supports batches of 1–20 independent Choice, Score, or Noul questions against up to 100,000 characters of sanitized text.
- Uses `jev-latest` at TypeSafe's official hosted endpoint. Supplied context leaves your machine.
- Preserves probabilities and confidence; Noul has a yes-probability, not a separate confidence value.
- Results are advisory. They cannot authorize actions or bypass user confirmation.
- Cancels with the session, times out after 30 seconds, and rejects redirects. Does not automatically retry billable requests.
- Returns HTTP status guidance without echoing server error bodies that might contain sensitive data.

## Verification

```sh
bun test plugins/jev
```
