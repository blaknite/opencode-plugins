# GitHub PR subscriptions

An OpenCode V2 plugin that brings GitHub reviews and check results back to the session watching a PR. Uses your existing `gh` authentication; no relay or public endpoint required.

Ask the agent to:

- “Watch owner/repo#123 for four hours.”
- “List this session's PR subscriptions.”
- “Stop watching owner/repo#123.”
- “Remove all PR subscriptions for this session.”

## Tools

- `github_pr_subscribe`: `pr`, optional `timeout_hours` (default 24; `null` explicitly disables expiry), optional `delivery` (`queue` by default, or `steer`). Calling again resets expiry from now without resetting the event baseline.
- `github_pr_unsubscribe`: either `pr` or `all: true`. Only affects the calling session.
- `github_pr_subscriptions`: lists active subscriptions, delivery modes, and expiry timestamps.

Subscriptions and event baselines persist in OpenCode's plugin storage. Existing activity at subscription time is not delivered. New reviews, edited/new review and discussion comments, failed checks, and all checks passing are delivered in one batch per poll. Merge or close delivers a final event and removes the subscription. Successful check rollups report at most once per head; skipped and neutral checks count as passing.

## Polling and delivery

Active PRs are polled every 60 seconds. A lightweight timer checks storage every 15 seconds, but makes no GitHub requests without active subscriptions. Sessions watching the same PR in the same location share fetches during each poll. Each PR fetch normally makes four requests: the PR/check rollup, reviews, inline comments, and discussion comments. Comment/review pagination can add requests. Large subscription counts will consume GitHub API quota.

Errors back off exponentially, up to an hour. Baselines advance only after delivery succeeds, and retries for the same batch use the same inbox message ID. Warnings intentionally omit credentials and raw GitHub response content. Check `gh auth status` when requests fail.

Events resume the recorded session through OpenCode's durable synthetic inbox, even when its tab isn't open. The default queues behind active work. Investigation-only instructions are included; these are not a security sandbox, and normal session permissions still apply. Raw PR titles, comment bodies, and check output are not included. The agent fetches details separately as untrusted data.

Expiry stops future admission. Unsubscribe removes the stored subscription; messages already admitted to OpenCode's inbox aren't recalled. Polling only observes snapshots: events created and deleted between polls can be missed. The OpenCode service must be running; this plugin does not wake the machine.

The plugin is discovered automatically from this global `plugins/github-pr/` directory. Project/location instances start when OpenCode loads that location; persisted subscriptions do not independently activate an unloaded location after a service restart. Reopen the project/session to restore its watcher.

## Verification

```sh
bun test plugins/github-pr
```
