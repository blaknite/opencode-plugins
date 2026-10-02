import { test, expect } from "bun:test";
import plugin from "./index.ts";

test("registers a decision tool and guidance for every agent-loop request", async () => {
  const tools: Array<{ name: string; input: unknown }> = [];
  const hooks = new Map<string, (event: { system: Array<{ type: string; text: string }> }) => void>();
  const ctx = {
    tool: {
      transform: async (register: (editor: { add: (tool: typeof tools[number]) => void }) => void) => {
        register({ add: (tool) => tools.push(tool) });
      },
    },
    session: {
      hook: async (name: string, callback: (event: { system: Array<{ type: string; text: string }> }) => void) => {
        hooks.set(name, callback);
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0];

  await plugin.setup(ctx);
  expect(tools.map((tool) => tool.name)).toEqual(["jev_evaluate"]);
  expect(tools[0].input).toHaveProperty("properties.questions");
  const event = { system: [] as Array<{ type: string; text: string }> };
  hooks.get("context")!(event);
  expect(event.system[0].text).toContain("advisory evidence");
  expect(event.system[0].text).toContain("never send secrets");
});
