import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { expiry, parsePullRequest, updates, type Snapshot } from "./core.ts";
import { Watcher } from "./watcher.ts";
import plugin from "./index.ts";

function fixture() {
  let now = 1_000_000;
  let snapshot: Snapshot = {
    head: "abc",
    state: "OPEN",
    events: {},
    allPassed: false,
  };
  let fetches = 0;
  let failDelivery = false;
  const storage = new Map<string, unknown>();
  const messages: {
    id: string;
    sessionID: string;
    text: string;
    delivery: string;
  }[] = [];
  const ctx = {
    location: { directory: "/project" },
    storage: {
      scan: async ({
        prefix,
        after,
        limit,
      }: {
        prefix: string;
        after?: string;
        limit: number;
      }) => {
        const keys = [...storage.keys()]
          .filter((key) => key.startsWith(prefix) && (!after || key > after))
          .sort();
        return {
          entries: keys
            .slice(0, limit)
            .map((key) => ({ key, value: structuredClone(storage.get(key)) })),
          next: keys.length > limit ? keys[limit - 1] : undefined,
        };
      },
      set: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
      },
      remove: async (key: string) => {
        storage.delete(key);
      },
    },
    session: {
      synthetic: async (message: (typeof messages)[number]) => {
        messages.push(message);
        if (failDelivery) throw new Error("offline");
      },
    },
  } as unknown as Context;
  const fetch = async () => {
    fetches++;
    return structuredClone(snapshot);
  };
  return {
    ctx,
    storage,
    messages,
    fetch,
    watcher: new Watcher(ctx, fetch, () => now),
    get fetches() {
      return fetches;
    },
    advance: (ms = 60_000) => {
      now += ms;
    },
    change: (value: Partial<Snapshot>) => {
      snapshot = { ...snapshot, ...value };
    },
    fail: (value: boolean) => {
      failDelivery = value;
    },
    restart: () => new Watcher(ctx, fetch, () => now),
  };
}

test("PR parsing rejects unsupported hosts and shell-like input", () => {
  expect(parsePullRequest("https://github.com/Owner/Repo/pull/123").url).toBe(
    "https://github.com/owner/repo/pull/123",
  );
  expect(parsePullRequest("owner/repo#123").number).toBe(123);
  for (const input of [
    "https://evil.test/o/r/pull/1",
    "o/r#0",
    "o/r#1; echo hi",
    "../r#1",
  ])
    expect(() => parsePullRequest(input)).toThrow();
});

test("default expiry, no expiry, and duration validation", () => {
  expect(expiry(undefined, 0)).toBe(86_400_000);
  expect(expiry(null, 0)).toBeNull();
  for (const value of [0, -1, Infinity, NaN, 8761])
    expect(() => expiry(value, 0)).toThrow();
});

test("baseline does not deliver old events; restart delivers new events once", async () => {
  const f = fixture();
  f.change({ events: { "review:1": "Review 1: APPROVED." } });
  await f.watcher.subscribe("ses_a", "o/r#1");
  await f.watcher.poll();
  expect(f.messages).toHaveLength(0);
  f.change({
    events: {
      "review:1": "Review 1: APPROVED.",
      "line:2": "Review comment 2.",
    },
  });
  f.advance();
  const restarted = f.restart();
  await restarted.poll();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0].sessionID).toBe("ses_a");
  expect(f.messages[0].delivery).toBe("queue");
  f.advance();
  await restarted.poll();
  expect(f.messages).toHaveLength(1);
});

test("polling shares GitHub requests and unsubscribe is session scoped", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "o/r#1");
  await f.watcher.subscribe("ses_b", "o/r#1");
  const before = f.fetches;
  f.change({ events: { "review:1": "Review 1." } });
  await f.watcher.poll();
  expect(f.fetches - before).toBe(1);
  expect(f.messages.map((message) => message.sessionID).sort()).toEqual([
    "ses_a",
    "ses_b",
  ]);
  expect(await f.watcher.unsubscribe("ses_a", "o/r#1")).toBe(1);
  expect(await f.watcher.list("ses_a")).toHaveLength(0);
  expect(await f.watcher.list("ses_b")).toHaveLength(1);
});

test("expired subscriptions make no GitHub requests, including after restart", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "o/r#1", 0.01);
  const before = f.fetches;
  f.advance();
  await f.restart().poll();
  expect(f.fetches).toBe(before);
  expect(f.storage.size).toBe(0);
  expect(f.messages).toHaveLength(0);
});

test("renewing keeps the baseline and extends expiry", async () => {
  const f = fixture();
  const old = await f.watcher.subscribe("ses_a", "o/r#1", 1);
  f.change({ events: { "review:1": "Review 1." } });
  f.advance();
  const renewed = await f.watcher.subscribe("ses_a", "o/r#1", 2, "steer");
  expect(renewed.expiresAt!).toBeGreaterThan(old.expiresAt!);
  expect(f.fetches).toBe(1);
  await f.watcher.poll();
  expect(f.messages[0].delivery).toBe("steer");
});

test("successful checks notify once per head; empty/pending snapshots do not notify", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "o/r#1");
  f.change({ allPassed: true });
  await f.watcher.poll();
  f.advance();
  f.change({ allPassed: false });
  await f.watcher.poll();
  f.advance();
  f.change({ allPassed: true });
  await f.watcher.poll();
  expect(f.messages).toHaveLength(1);
  f.advance();
  f.change({ head: "def" });
  await f.watcher.poll();
  expect(f.messages).toHaveLength(2);
});

test("merge and close deliver a final event before removing the subscription", async () => {
  for (const state of ["MERGED", "CLOSED"] as const) {
    const f = fixture();
    await f.watcher.subscribe("ses_a", "o/r#1", null);
    f.change({ state });
    await f.watcher.poll();
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].text).toContain("Subscription ended");
    expect(f.storage.size).toBe(0);
  }
});

test("failed delivery preserves cursor and retries with a stable message ID", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "o/r#1");
  f.change({ events: { "review:1": "Review 1." } });
  f.fail(true);
  await f.watcher.poll();
  expect((await f.watcher.list("ses_a"))[0].snapshot.events).toEqual({});
  f.fail(false);
  f.advance(120_000);
  await f.watcher.poll();
  expect(f.messages[0].id).toBe(f.messages[1].id);
  expect(f.messages[0].id).toMatch(/^msg_/);
});

test("review state changes are detected", async () => {
  const f = fixture();
  const row = await f.watcher.subscribe("ses_a", "o/r#1");
  expect(
    updates(row, {
      ...row.snapshot,
      events: { "review:1": "Review 1: DISMISSED." },
    }),
  ).toEqual(["Review 1: DISMISSED."]);
});

test("plugin registers only the three GitHub-specific tools and cleans up", async () => {
  const f = fixture();
  const tools = new Map<
    string,
    { execute: (input: unknown, context: unknown) => Promise<unknown> }
  >();
  const ctx = {
    ...f.ctx,
    tool: {
      transform: async (
        callback: (editor: {
          add: (tool: {
            name: string;
            execute: (input: unknown, context: unknown) => Promise<unknown>;
          }) => void;
        }) => void,
      ) => callback({ add: (tool) => tools.set(tool.name, tool) }),
    },
  } as unknown as Context;
  const cleanup = await plugin.setup(ctx);
  expect([...tools.keys()]).toEqual([
    "github_pr_subscribe",
    "github_pr_unsubscribe",
    "github_pr_subscriptions",
  ]);
  await expect(
    tools.get("github_pr_unsubscribe")!.execute({}, { sessionID: "ses_a" }),
  ).rejects.toThrow("Provide either");
  await expect(
    tools
      .get("github_pr_unsubscribe")!
      .execute({ pr: "o/r#1", all: true }, { sessionID: "ses_a" }),
  ).rejects.toThrow("Provide either");
  cleanup();
});

test("one failing session does not block delivery to another", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "o/r#1");
  await f.watcher.subscribe("ses_b", "o/r#1");
  const deliver = f.ctx.session.synthetic;
  f.ctx.session.synthetic = async (input) => {
    if (input.sessionID === "ses_b") throw new Error("missing session");
    return deliver(input);
  };
  f.change({ events: { "review:1": "Review 1." } });
  await f.watcher.poll();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0].sessionID).toBe("ses_a");
});

test("unsubscribe all removes only the calling session's subscriptions", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "o/r#1");
  await f.watcher.subscribe("ses_a", "o/r#2");
  await f.watcher.subscribe("ses_b", "o/r#1");
  expect(await f.watcher.unsubscribe("ses_a")).toBe(2);
  expect(await f.watcher.list("ses_a")).toHaveLength(0);
  expect(await f.watcher.list("ses_b")).toHaveLength(1);
});
