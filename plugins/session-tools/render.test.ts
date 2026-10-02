import { test, expect } from "bun:test";
import { renderSessionBlocks, chunkBlocks } from "./render.ts";

test("renders V2 user messages and assistant tool results", () => {
  const messages = [
    { type: "user", text: "What changed?" },
    {
      type: "assistant",
      agent: "build",
      content: [
        { type: "text", text: "Found the change." },
        { type: "reasoning", text: "private reasoning" },
        {
          type: "tool",
          name: "read",
          state: {
            status: "completed",
            input: { filePath: "example.ts" },
            content: [{ type: "text", text: "file contents" }],
          },
        },
      ],
    },
  ] as unknown as Parameters<typeof renderSessionBlocks>[0];

  const result = renderSessionBlocks(messages, {
    title: "Example",
    directory: "/project",
    perPartTruncation: 4000,
  });
  expect(result.header).toContain("Example");
  expect(result.blocks).toEqual([
    "## user\nWhat changed?",
    '## assistant (build)\nFound the change.\n\n```tool: read {"filePath":"example.ts"}\nfile contents\n```',
  ]);
  expect(chunkBlocks(result, 50).length).toBeGreaterThan(1);
});
