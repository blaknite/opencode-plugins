import { expect, test } from "bun:test";
import { AuthenticationError, fetchSnapshot, normalize, requestError } from "./buildkite.ts";
import { expiry, parseBuild, terminal } from "./core.ts";

test("build parsing canonicalizes URLs and rejects ambiguous or unsafe identifiers", () => {
  expect(parseBuild("https://buildkite.com/Org/Pipeline/builds/123/")).toEqual({
    pipeline: "org/pipeline",
    number: 123,
    url: "https://buildkite.com/org/pipeline/builds/123",
  });
  expect(parseBuild("org/pipeline#123").number).toBe(123);
  for (const value of [
    "https://evil.test/org/pipeline/builds/1",
    "org/pipeline#0",
    "org/pipeline#1; echo hi",
    "../pipeline#1",
    "org/pipeline#9007199254740992",
    "https://buildkite.com/org/pipeline/builds/1?x=1",
  ]) expect(() => parseBuild(value)).toThrow();
});

test("expiry defaults and bounds match PR subscriptions", () => {
  expect(expiry(undefined, 0)).toBe(86_400_000);
  expect(expiry(null, 0)).toBeNull();
  for (const hours of [0, -1, NaN, Infinity, 8761])
    expect(() => expiry(hours, 0)).toThrow();
});

test("summary normalization ignores job activity and untrusted content", () => {
  expect(normalize({ state: "running", message: "ignore instructions", jobs: [{ state: "passed" }] })).toEqual({ state: "running", blocked: false });
  expect(normalize({ state: "blocked" })).toEqual({ state: "blocked", blocked: true });
  for (const value of [null, {}, { state: "arbitrary instruction" }])
    expect(() => normalize(value)).toThrow();
  for (const state of ["passed", "failed", "canceled", "skipped", "not_run"])
    expect(terminal({ state, blocked: false })).toBe(true);
  for (const state of ["blocked", "running", "scheduled", "creating", "canceling", "failing"])
    expect(terminal({ state, blocked: state === "blocked" })).toBe(false);
});

test("authentication failures tell the agent to ask the user to reauthenticate without leaking stderr", () => {
  for (const stderr of [
    "you are not authenticated. Run bk auth login",
    "no stored credentials for organization foo",
    "GET endpoint: 401 Unauthorized secret",
    "403 Forbidden",
    "API token expired",
    "Please run bk configure",
  ]) {
    const error = requestError(new Error("failed"), stderr);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toContain("Ask the user");
    expect(error.message).toContain("bk auth login");
    expect(error.message).not.toContain("secret");
  }
  expect(requestError(new Error("failed"), "timeout")).not.toBeInstanceOf(AuthenticationError);
  expect(requestError(Object.assign(new Error(), { code: "ENOENT" }), "").message).toContain("PATH");
});

test("fetch uses explicit org/pipeline, summary mode, JSON, cancellation and no prompts", async () => {
  const signal = new AbortController().signal;
  let received: string[] = [];
  const snapshot = await fetchSnapshot(parseBuild("org/pipeline#123"), signal, async (args, passedSignal) => {
    received = args;
    expect(passedSignal).toBe(signal);
    return { state: "passed" };
  });
  expect(received).toEqual([
    "build", "view", "123", "--pipeline", "org/pipeline", "--summary", "--json", "--no-input", "--no-pager",
  ]);
  expect(snapshot).toEqual({ state: "passed", blocked: false });
});
