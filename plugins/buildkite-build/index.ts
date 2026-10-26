import type { Plugin } from "@opencode/plugin/promise/plugin";
import { terminal } from "./core.ts";
import { Watcher } from "./watcher.ts";

export default {
  id: "buildkite-build",
  async setup(ctx) {
    const watcher = new Watcher(ctx);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "buildkite_build_subscribe",
        description:
          "Watch a Buildkite build in this session for blocked, failing, and terminal state changes using bk CLI authentication. Polls active subscriptions every 60 seconds. Returns current status without notifying for existing activity; terminal builds are not subscribed. Defaults to 24 hours, queued delivery, and investigation only. Calling again renews the subscription and validates authentication; null timeout explicitly disables expiry.",
        input: {
          type: "object",
          properties: {
            build: {
              type: "string",
              description: "buildkite.com build URL or org/pipeline#123",
            },
            timeout_hours: {
              type: ["number", "null"],
              exclusiveMinimum: 0,
              maximum: 8760,
              description:
                "Duration from now (default 24); null explicitly means no expiry",
            },
            delivery: {
              type: "string",
              enum: ["queue", "steer"],
              description:
                "Queue behind active work (default), or steer at the next step boundary",
            },
          },
          required: ["build"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as {
            build: string;
            timeout_hours?: number | null;
            delivery?: "queue" | "steer";
          };
          const row = await watcher.subscribe(
            context.sessionID,
            args.build,
            args.timeout_hours,
            args.delivery,
            context.signal,
          );
          return {
            content: JSON.stringify({
              build: row.build.url,
              state: row.snapshot.state,
              blocked: row.snapshot.blocked,
              subscribed: !terminal(row.snapshot),
              expires_at:
                row.expiresAt === null
                  ? null
                  : new Date(row.expiresAt).toISOString(),
              delivery: row.delivery,
            }),
          };
        },
      });
      editor.add({
        name: "buildkite_build_unsubscribe",
        description:
          "Stop watching a Buildkite build in this session. Set all to true to remove every build subscription for this session. Already admitted session messages remain in history/inbox.",
        input: {
          type: "object",
          properties: { build: { type: "string" }, all: { type: "boolean" } },
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as { build?: string; all?: boolean };
          if (
            (!args.build && args.all !== true) ||
            (args.build && args.all === true)
          )
            throw new Error("Provide either build or all: true.");
          const count = await watcher.unsubscribe(context.sessionID, args.build);
          return {
            content: `Removed ${count} build subscription(s) from this session.`,
          };
        },
      });
      editor.add({
        name: "buildkite_build_subscriptions",
        description:
          "List this session's active Buildkite build subscriptions, latest observed states, expiry times, and delivery modes.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          const rows = await watcher.list(context.sessionID);
          return {
            content: JSON.stringify(
              rows.map((row) => ({
                build: row.build.url,
                state: row.snapshot.state,
                blocked: row.snapshot.blocked,
                subscribed: !terminal(row.snapshot),
                expires_at:
                  row.expiresAt === null
                    ? null
                    : new Date(row.expiresAt).toISOString(),
                delivery: row.delivery,
              })),
            ),
          };
        },
      });
    });
    const timer = setInterval(
      () =>
        void watcher
          .poll()
          .catch(() =>
            console.warn("buildkite-build: could not read subscription storage."),
          ),
      15_000,
    );
    timer.unref();
    void watcher
      .poll()
      .catch(() =>
        console.warn("buildkite-build: could not restore subscriptions."),
      );
    return () => {
      clearInterval(timer);
      watcher.stop();
    };
  },
} satisfies Plugin;
