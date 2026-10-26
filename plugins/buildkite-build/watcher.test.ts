import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import { AuthenticationError } from "./buildkite.ts";
import { expiry, parseBuild, type Snapshot } from "./core.ts";
import { Watcher } from "./watcher.ts";

function fixture() {
  let now = 1_000_000;
  let snapshot: Snapshot = { state: "scheduled", blocked: false };
  let fetches = 0;
  let failDelivery = false;
  let fetchError: Error | undefined;
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
    if (fetchError) throw fetchError;
    return structuredClone(snapshot);
  };
  return {
    ctx,
    storage,
    messages,
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
    error: (value?: Error) => {
      fetchError = value;
    },
    restart: () => new Watcher(ctx, fetch, () => now),
  };
}

test("build parsing accepts shorthand and canonical URLs, rejecting unsafe input", () => {
  expect(parseBuild("Org/Pipeline#123")).toEqual({
    pipeline: "org/pipeline",
    number: 123,
    url: "https://buildkite.com/org/pipeline/builds/123",
  });
  expect(parseBuild("https://buildkite.com/org/pipeline/builds/123")).toEqual(
    parseBuild("org/pipeline#123"),
  );
  for (const input of [
    "https://evil.test/org/pipeline/builds/1",
    "org/pipeline#0",
    "org/pipeline#1; echo hi",
    "../pipeline#1",
  ])
    expect(() => parseBuild(input)).toThrow();
});

test("default expiry, no expiry, and duration validation", () => {
  expect(expiry(undefined, 0)).toBe(86_400_000);
  expect(expiry(null, 0)).toBeNull();
  for (const value of [0, -1, Infinity, NaN, 8761])
    expect(() => expiry(value, 0)).toThrow();
});

test("routine build transitions stay silent and advance the baseline", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  for (const state of ["creating", "scheduled", "running", "canceling"]) {
    f.change({ state });
    await f.watcher.poll();
    expect((await f.watcher.list("ses_a"))[0].snapshot.state).toBe(state);
    f.advance();
  }
  expect(f.messages).toHaveLength(0);
});

test("blocked notifies once until unblocked, then notifies on reblock", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  f.change({ state: "blocked", blocked: true });
  await f.watcher.poll();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0].text).toContain("blocked");
  expect(f.messages[0].delivery).toBe("queue");
  f.advance();
  await f.watcher.poll();
  expect(f.messages).toHaveLength(1);
  f.advance();
  f.change({ state: "running", blocked: false });
  await f.watcher.poll();
  expect(f.messages).toHaveLength(1);
  f.advance();
  f.change({ state: "blocked", blocked: true });
  await f.watcher.poll();
  expect(f.messages).toHaveLength(2);
  expect(f.messages[1].id).not.toBe(f.messages[0].id);
});

test("an initially blocked build is returned as the baseline without notifying", async () => {
  const f = fixture();
  f.change({ state: "blocked", blocked: true });
  const row = await f.watcher.subscribe("ses_a", "org/pipeline#1");
  expect(row.snapshot).toEqual({ state: "blocked", blocked: true });
  await f.watcher.poll();
  expect(f.messages).toHaveLength(0);
  expect(await f.watcher.list("ses_a")).toHaveLength(1);
});

test("failing notifies once per transition", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  f.change({ state: "failing" });
  await f.watcher.poll();
  f.advance();
  await f.watcher.poll();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0].text).toContain("failing");
});

test("terminal states notify before removing the subscription", async () => {
  for (const state of ["passed", "failed", "canceled", "skipped", "not_run"]) {
    const f = fixture();
    await f.watcher.subscribe("ses_a", "org/pipeline#1", null);
    f.change({ state });
    await f.watcher.poll();
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0].text).toContain(state);
    expect(f.messages[0].text).toContain("Subscription ended");
    expect(f.storage.size).toBe(0);
    const before = f.fetches;
    f.advance();
    await f.watcher.poll();
    expect(f.fetches).toBe(before);
    expect(f.messages).toHaveLength(1);
  }
});

test("initially terminal builds are not stored or delivered", async () => {
  for (const state of ["passed", "failed", "canceled", "skipped", "not_run"]) {
    const f = fixture();
    f.change({ state });
    const row = await f.watcher.subscribe("ses_a", "org/pipeline#1");
    expect(row.snapshot.state).toBe(state);
    expect(await f.watcher.list("ses_a")).toHaveLength(0);
    expect(f.storage.size).toBe(0);
    expect(f.messages).toHaveLength(0);
  }
});

test("authentication failure during subscribe explains reauthentication without storing a subscription", async () => {
  const f = fixture();
  f.error(new AuthenticationError());
  await expect(
    f.watcher.subscribe("ses_a", "org/pipeline#1"),
  ).rejects.toThrow("bk auth login");
  expect(f.storage.size).toBe(0);
  expect(f.messages).toHaveLength(0);
});

test("polling authentication failure notifies once, survives restart, and resumes", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  f.error(new AuthenticationError());
  await f.watcher.poll();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0].text).toContain("bk auth login");
  expect((await f.watcher.list("ses_a"))[0].authNotified).toBe(true);
  f.advance(3_600_000);
  const restarted = f.restart();
  await restarted.poll();
  expect(f.messages).toHaveLength(1);
  f.error();
  f.change({ state: "running" });
  f.advance(3_600_000);
  await restarted.poll();
  expect((await restarted.list("ses_a"))[0].authNotified).toBeFalsy();
  expect((await restarted.list("ses_a"))[0].snapshot.state).toBe("running");
  f.error(new AuthenticationError());
  f.advance(3_600_000);
  await restarted.poll();
  expect(f.messages).toHaveLength(2);
  expect(f.messages[1].id).not.toBe(f.messages[0].id);
  f.error();
  f.change({ state: "passed" });
  f.advance(3_600_000);
  await restarted.poll();
  expect(f.messages).toHaveLength(3);
  expect(f.messages[2].text).toContain("passed");
  expect(f.storage.size).toBe(0);
});

test("failed delivery preserves the baseline and retries with a stable message ID", async () => {
  for (const state of ["blocked", "passed"]) {
    const f = fixture();
    await f.watcher.subscribe("ses_a", "org/pipeline#1");
    f.change({ state, blocked: state === "blocked" });
    f.fail(true);
    await f.watcher.poll();
    expect((await f.watcher.list("ses_a"))[0].snapshot).toEqual({
      state: "scheduled",
      blocked: false,
    });
    f.fail(false);
    f.advance(3_600_000);
    await f.watcher.poll();
    expect(f.messages).toHaveLength(2);
    expect(f.messages[0].id).toMatch(/^msg_/);
    expect(f.messages[0].id).toBe(f.messages[1].id);
    expect(await f.watcher.list("ses_a")).toHaveLength(state === "passed" ? 0 : 1);
  }
});

test("failed authentication notification is retried before marking it delivered", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  f.error(new AuthenticationError());
  f.fail(true);
  await f.watcher.poll();
  expect((await f.watcher.list("ses_a"))[0].authNotified).toBeFalsy();
  f.fail(false);
  f.advance(3_600_000);
  await f.watcher.poll();
  expect(f.messages).toHaveLength(2);
  expect(f.messages[0].id).toBe(f.messages[1].id);
  expect((await f.watcher.list("ses_a"))[0].authNotified).toBe(true);
});

test("polling shares fetches for the same build across sessions", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  await f.watcher.subscribe("ses_b", "https://buildkite.com/org/pipeline/builds/1");
  const before = f.fetches;
  f.change({ state: "blocked", blocked: true });
  await f.watcher.poll();
  expect(f.fetches - before).toBe(1);
  expect(f.messages.map((message) => message.sessionID).sort()).toEqual([
    "ses_a",
    "ses_b",
  ]);
});

test("expiry removes subscriptions without fetching, including after restart", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1", 0.01);
  const before = f.fetches;
  f.advance();
  await f.restart().poll();
  expect(f.fetches).toBe(before);
  expect(f.storage.size).toBe(0);
  expect(f.messages).toHaveLength(0);
});

test("unsubscribe by build and unsubscribe all are session scoped", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  await f.watcher.subscribe("ses_a", "org/pipeline#2");
  await f.watcher.subscribe("ses_b", "org/pipeline#1");
  expect(
    await f.watcher.unsubscribe("ses_a", "https://buildkite.com/org/pipeline/builds/1"),
  ).toBe(1);
  expect(await f.watcher.list("ses_a")).toHaveLength(1);
  expect(await f.watcher.list("ses_b")).toHaveLength(1);
  expect(await f.watcher.unsubscribe("ses_a")).toBe(1);
  expect(await f.watcher.list("ses_a")).toHaveLength(0);
  expect(await f.watcher.list("ses_b")).toHaveLength(1);
});

test("restart and renewal preserve an undelivered change and extend expiry", async () => {
  const f = fixture();
  const old = await f.watcher.subscribe("ses_a", "org/pipeline#1", 1);
  f.change({ state: "blocked", blocked: true });
  f.fail(true);
  await f.watcher.poll();
  f.advance();
  const restarted = f.restart();
  const renewed = await restarted.subscribe("ses_a", "org/pipeline#1", 2, "steer");
  expect(renewed.id).toBe(old.id);
  expect(renewed.expiresAt!).toBeGreaterThan(old.expiresAt!);
  expect((await restarted.list("ses_a"))[0].snapshot).toEqual(old.snapshot);
  f.fail(false);
  await restarted.poll();
  expect(f.messages).toHaveLength(2);
  expect(f.messages[1].delivery).toBe("steer");
  expect(f.messages[1].text).toContain("blocked");
  f.advance();
  await restarted.poll();
  expect(f.messages).toHaveLength(2);
});

test("one failing session does not block another session's delivery", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  await f.watcher.subscribe("ses_b", "org/pipeline#1");
  const deliver = f.ctx.session.synthetic;
  f.ctx.session.synthetic = async (input) => {
    if (input.sessionID === "ses_b") throw new Error("missing session");
    return deliver(input);
  };
  f.change({ state: "passed" });
  await f.watcher.poll();
  expect(f.messages).toHaveLength(1);
  expect(f.messages[0].sessionID).toBe("ses_a");
  expect(await f.watcher.list("ses_a")).toHaveLength(0);
  expect(await f.watcher.list("ses_b")).toHaveLength(1);
});

test("stopping a watcher prevents polling requests and notifications", async () => {
  const f = fixture();
  await f.watcher.subscribe("ses_a", "org/pipeline#1");
  const before = f.fetches;
  f.change({ state: "passed" });
  f.watcher.stop();
  await f.watcher.poll();
  expect(f.fetches).toBe(before);
  expect(f.messages).toHaveLength(0);
});
