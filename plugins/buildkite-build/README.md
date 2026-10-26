# Buildkite build subscriptions

Watches specific builds using `bk build view --summary --json`. Requires a recent Buildkite CLI supporting `--summary`, available on the OpenCode service's PATH and authenticated with `bk auth login`.

## Tools

- `buildkite_build_subscribe`: accepts `build` as a Buildkite build URL or `org/pipeline#123`, optional `timeout_hours` (default 24; `null` disables expiry), and `delivery` (`queue` by default, or `steer`). Calling again renews the subscription.
- `buildkite_build_unsubscribe`: accepts one `build`, or `all: true`, for this session only.
- `buildkite_build_subscriptions`: lists this session's active subscriptions.

The subscribe result includes the current state. A build that's already terminal is returned immediately without registering a subscription. Existing blocked/failing states establish the baseline rather than generating a redundant notification.

## Notifications

The subscribing session receives a synthetic message and resumes when a build becomes blocked or failing, or finishes as passed, failed, canceled, skipped, or not run. Terminal notifications end the subscription. Scheduled/running transitions, job completions, logs, and annotations do not generate notifications. The watcher never retries, cancels, or unblocks a build.

Authentication/access failures explicitly instruct the subscribing agent to ask the user to reauthenticate their CLI with `bk auth login`. Initial authentication failures do not create a subscription. During polling, the subscription is retained and the agent is notified once per authentication failure episode, rather than on every poll. Raw CLI errors and credentials are never included in notifications.

## Lifecycle

Subscriptions persist in plugin storage, scoped to the location and subscribing session. Active subscriptions are polled roughly every minute; failures back off. Multiple sessions watching one build share a request per poll. Failed deliveries retain their baseline and retry with a stable message ID. Expired subscriptions are removed silently.

Polling runs only while the plugin is loaded and cannot report transitions that occur entirely between successful polls. A blocked build remains subscribed so it can later report completion. Once a terminal notification is delivered, later retries of that build require a new subscription.
