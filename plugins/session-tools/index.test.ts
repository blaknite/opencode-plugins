import { test, expect } from "bun:test";
import plugin from "./index.ts";

test("read_session uses V2 context and one-shot generation", async () => {
  const tools = new Map<
    string,
    {
      execute: (
        input: unknown,
        context: unknown,
      ) => Promise<{ content?: string }>;
    }
  >();
  const prompts: string[] = [];
  const ctx = {
    tool: {
      transform: async (
        register: (editor: {
          add: (tool: {
            name: string;
            execute: (
              input: unknown,
              context: unknown,
            ) => Promise<{ content?: string }>;
          }) => void;
        }) => void,
      ) => {
        register({ add: (tool) => tools.set(tool.name, tool) });
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        title: "Earlier work",
        location: { directory: "/project" },
        model: { providerID: "test", id: "example" },
      }),
      context: async () => [
        { type: "user", text: "Where is the fix?" },
        {
          type: "assistant",
          agent: "build",
          content: [{ type: "text", text: "In src/fix.ts" }],
        },
      ],
    },
    model: {
      list: async () => ({
        data: [
          { providerID: "test", id: "example", limit: { context: 128000 } },
        ],
      }),
    },
    generate: {
      text: async ({ prompt }: { prompt: string }) => {
        prompts.push(prompt);
        return { text: "The fix is in src/fix.ts" };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);
  const result = await tools
    .get("read_session")!
    .execute(
      { session_id: "ses_old", query: "Where is the fix?" },
      { sessionID: "ses_current", progress: async () => {} },
    );

  expect(result.content).toBe("The fix is in src/fix.ts");
  expect(prompts[0]).toContain("src/fix.ts");
  expect(prompts).toHaveLength(1);
});
