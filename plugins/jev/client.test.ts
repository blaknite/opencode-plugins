import { test, expect } from "bun:test";
import { evaluate } from "./client.ts";

const input = {
  state: "A small refactor with passing tests.",
  questions: {
    risk: { type: "score", instructions: "Rate the risk", criteria: ["Low", "High"] },
    route: { type: "choice", instructions: "Choose next step", criteria: { review: null, revise: "Needs changes" } },
    tested: { type: "noul", instructions: "Are tests passing?" },
  },
};
const result = {
  model: "jev-test",
  answers: {
    risk: { type: "score", score: 0.1, legend: { "0": "Low", "1": "High" }, probabilities: { "0": 0.9, "1": 0.1 }, confidence: 0.8 },
    route: { type: "choice", choice: "review", probabilities: { review: 0.9, revise: 0.1 }, confidence: 0.8 },
    tested: { type: "noul", noul: 0.99 },
  },
  usage: { input_tokens: 100, output_tokens: 20 },
} as const;

function options(handler: (url: string | URL | Request, init?: RequestInit) => Promise<Response>) {
  return { apiKey: "test-key", signal: new AbortController().signal, fetch: handler as typeof fetch };
}

test("sends explicit context and all question types, preserving results", async () => {
  const actual = await evaluate(input, options(async (url, init) => {
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: "Bearer test-key", "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({ ...input, model: "jev-latest" });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json(result);
  }));
  expect(actual).toEqual(result);
});

test("missing credentials fail before making a request", async () => {
  await expect(evaluate(input, { signal: new AbortController().signal })).rejects.toThrow("TYPESAFE_API_KEY");
});

test("rejects invalid questions before sending", async () => {
  let calls = 0;
  const opts = options(async () => { calls++; return Response.json(result); });
  for (const invalid of [
    { ...input, questions: {} },
    { ...input, questions: { q: { type: "score", instructions: "Rate", criteria: ["One"] } } },
    { ...input, questions: { q: { type: "choice", instructions: "Choose", criteria: {} } } },
    { ...input, state: "" },
  ]) {
    await expect(evaluate(invalid, opts)).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("HTTP errors do not echo potentially sensitive response bodies", async () => {
  for (const status of [401, 422, 429, 529]) {
    await expect(evaluate(input, options(async () => new Response("secret server data", { status })))).rejects.toThrow(`HTTP ${status}`);
  }
});

test("rejects invalid or mismatched answers", async () => {
  for (const invalid of [
    {},
    { ...result, answers: {} },
    { ...result, answers: { ...result.answers, tested: { type: "noul", noul: 2 } } },
    { ...result, answers: { ...result.answers, tested: result.answers.risk } },
    { ...result, answers: { ...result.answers, route: { ...result.answers.route, choice: "unknown" } } },
  ]) {
    await expect(evaluate(input, options(async () => Response.json(invalid)))).rejects.toThrow("Jev API");
  }
});

test("propagates session cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const opts = options(async (_url, init) => {
    expect(init?.signal?.aborted).toBe(true);
    init?.signal?.throwIfAborted();
    return Response.json(result);
  });
  await expect(evaluate(input, { ...opts, signal: controller.signal })).rejects.toThrow();
});
