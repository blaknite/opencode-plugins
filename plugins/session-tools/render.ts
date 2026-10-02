import type { Plugin } from "@opencode/plugin";

type Message = Awaited<
  ReturnType<Plugin.Context["session"]["context"]>
>[number];

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n... [${omitted} more characters truncated]`;
}

export type RenderedSession = {
  header: string;
  blocks: string[];
};

export function renderSessionBlocks(
  messages: readonly Message[],
  opts: { perPartTruncation: number; title: string; directory: string },
): RenderedSession {
  const header = `# Session: ${opts.title}\nDirectory: ${opts.directory}`;
  const blocks: string[] = [];

  for (const message of messages) {
    if (message.type === "user" && message.text.trim()) {
      blocks.push(`## user\n${message.text.trim()}`);
    }
    if (message.type !== "assistant") continue;

    const content: string[] = [];
    for (const part of message.content) {
      if (part.type === "text" && part.text.trim())
        content.push(part.text.trim());
      if (
        part.type !== "tool" ||
        (part.state.status !== "completed" && part.state.status !== "error")
      )
        continue;

      const input = JSON.stringify(part.state.input);
      const inputLine = input ? ` ${truncate(input, 500)}` : "";
      const output =
        part.state.status === "error"
          ? JSON.stringify(part.state.error)
          : part.state.content
              .filter((item) => item.type === "text")
              .map((item) => item.text)
              .join("\n");
      content.push(
        `\`\`\`tool: ${part.name}${inputLine}\n${truncate(output, opts.perPartTruncation)}\n\`\`\``,
      );
    }
    if (content.length)
      blocks.push(`## assistant (${message.agent})\n${content.join("\n\n")}`);
  }

  return { header, blocks };
}

export function chunkBlocks(
  rendered: RenderedSession,
  maxChars: number,
): string[] {
  const { header, blocks } = rendered;
  if (blocks.length === 0) return [];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = header.length;

  const flush = () => {
    if (current.length === 0) return;
    chunks.push([header, "", ...current].join("\n\n"));
    current = [];
    currentLen = header.length;
  };

  for (const block of blocks) {
    if (block.length > maxChars) {
      flush();
      for (let i = 0; i < block.length; i += maxChars) {
        chunks.push([header, "", block.slice(i, i + maxChars)].join("\n\n"));
      }
      continue;
    }
    if (currentLen + block.length + 2 > maxChars) flush();
    current.push(block);
    currentLen += block.length + 2;
  }
  flush();

  return chunks;
}
