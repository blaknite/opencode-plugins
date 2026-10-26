import { expect, test } from "bun:test";
import type { Context } from "@opencode/plugin/promise/plugin";
import plugin from "./index.ts";

type TestTool = {
  name: string;
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>;
};

test("plugin registers session-scoped tools and validates unsubscribe input", async () => {
  const tools = new Map<string, TestTool>();
  const ctx = {
    location: { directory: "/project" },
    storage: {
      scan: async () => ({ entries: [] }),
      set: async () => {},
      remove: async () => {},
    },
    tool: {
      transform: async (register: (editor: unknown) => void) => {
        register({
          add: (tool: TestTool) => tools.set(tool.name, tool),
        });
      },
    },
  } as unknown as Context;
  const cleanup = await plugin.setup(ctx);
  try {
    expect([...tools.keys()]).toEqual([
      "buildkite_build_subscribe",
      "buildkite_build_unsubscribe",
      "buildkite_build_subscriptions",
    ]);
    const context = { sessionID: "ses_a", signal: new AbortController().signal };
    expect(await tools.get("buildkite_build_subscriptions")!.execute({}, context)).toEqual({ content: "[]" });
    for (const input of [{}, { build: "org/pipeline#1", all: true }])
      await expect(tools.get("buildkite_build_unsubscribe")!.execute(input, context)).rejects.toThrow("either build or all");
    await expect(tools.get("buildkite_build_subscribe")!.execute({ build: "unsafe" }, context)).rejects.toThrow("buildkite.com");
    expect(await tools.get("buildkite_build_unsubscribe")!.execute({ all: true }, context)).toEqual({ content: "Removed 0 build subscription(s) from this session." });
  } finally {
    if (typeof cleanup === "function") cleanup();
  }
});
