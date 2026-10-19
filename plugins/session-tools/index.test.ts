import { test, expect } from "bun:test";
import plugin from "./index.ts";

test("list_sessions uses the current server without a registered service", async () => {
  let execute: ((input: unknown) => Promise<{ content?: string }>) | undefined;
  let requestUrl = "";
  const headers = new Headers();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      requestUrl = req.url;
      headers.set("authorization", req.headers.get("authorization") ?? "");
      return Response.json({
        data: [{
          id: "ses_previous",
          title: "Earlier work",
          time: { updated: Date.now() },
          location: { directory: "/project" },
        }],
      });
    },
  });
  const argv = process.argv;
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  const username = process.env.OPENCODE_SERVER_USERNAME;
  try {
    process.argv = ["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(server.port)];
    process.env.OPENCODE_SERVER_PASSWORD = "test-password";
    process.env.OPENCODE_SERVER_USERNAME = "opencode";
    await plugin.setup({
      location: { project: { id: "project-test", canonical: "/project" } },
      tool: {
        transform: async (register: (editor: { add: (tool: { name: string; execute: typeof execute }) => void }) => void) => {
          register({ add: (tool) => {
            if (tool.name === "list_sessions") execute = tool.execute;
          } });
        },
      },
    } as unknown as Parameters<typeof plugin.setup>[0]);

    const result = await execute!({});
    expect(result.content).toContain("ses_previous");
    expect(result.content).toContain("Earlier work");
    const url = new URL(requestUrl);
    expect(url.searchParams.get("project")).toBe("project-test");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("parentID")).toBe("null");
    expect(headers.get("authorization")).toBe(`Basic ${btoa("opencode:test-password")}`);

    await execute!({ all_projects: true, include_children: true, limit: 10 });
    const allProjectsUrl = new URL(requestUrl);
    expect(allProjectsUrl.searchParams.has("project")).toBe(false);
    expect(allProjectsUrl.searchParams.has("parentID")).toBe(false);
    expect(allProjectsUrl.searchParams.get("limit")).toBe("10");
  } finally {
    process.argv = argv;
    if (password === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = password;
    if (username === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = username;
    server.stop(true);
  }
});

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
