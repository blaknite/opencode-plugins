import type { Plugin } from "@opencode/plugin/promise/plugin";
import { Watcher } from "./watcher.ts";

export default {
  id: "github-pr",
  async setup(ctx) {
    const watcher = new Watcher(ctx);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "github_pr_subscribe",
        description:
          "Watch a GitHub PR in this session for new reviews, review/discussion comments, failed checks, all checks passing, merge and close. Polls only active subscriptions using gh authentication. Existing activity establishes a baseline without waking the session. Defaults to 24 hours, queued delivery, and investigation only. Calling again renews the subscription; null timeout explicitly disables expiry.",
        input: {
          type: "object",
          properties: {
            pr: {
              type: "string",
              description: "github.com PR URL or owner/repo#123",
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
          required: ["pr"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as {
            pr: string;
            timeout_hours?: number | null;
            delivery?: "queue" | "steer";
          };
          const row = await watcher.subscribe(
            context.sessionID,
            args.pr,
            args.timeout_hours,
            args.delivery,
            context.signal,
          );
          return {
            content: JSON.stringify({
              pr: row.pr.url,
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
        name: "github_pr_unsubscribe",
        description:
          "Stop watching a GitHub PR in this session. Set all to true to remove every PR subscription for this session. Already admitted session messages remain in history/inbox.",
        input: {
          type: "object",
          properties: { pr: { type: "string" }, all: { type: "boolean" } },
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as { pr?: string; all?: boolean };
          if ((!args.pr && args.all !== true) || (args.pr && args.all === true))
            throw new Error("Provide either pr or all: true.");
          const count = await watcher.unsubscribe(context.sessionID, args.pr);
          return {
            content: `Removed ${count} PR subscription(s) from this session.`,
          };
        },
      });
      editor.add({
        name: "github_pr_subscriptions",
        description:
          "List this session's active GitHub PR subscriptions, expiry times, and delivery modes.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input, context) {
          const rows = await watcher.list(context.sessionID);
          return {
            content: JSON.stringify(
              rows.map((row) => ({
                pr: row.pr.url,
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
            console.warn("github-pr: could not read subscription storage."),
          ),
      15_000,
    );
    timer.unref();
    void watcher
      .poll()
      .catch(() => console.warn("github-pr: could not restore subscriptions."));
    return () => {
      clearInterval(timer);
      watcher.stop();
    };
  },
} satisfies Plugin;
