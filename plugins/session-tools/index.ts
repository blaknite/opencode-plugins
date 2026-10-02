import type { Context, Plugin } from "@opencode/plugin/promise/plugin";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { renderSessionBlocks, chunkBlocks } from "./render.ts";
import { modelContextTokens } from "./context.ts";

const DEFAULT_MODEL = { providerID: "anthropic", id: "claude-haiku-4-5" };
const PER_PART_TRUNCATION = 4000;

const CHARS_PER_TOKEN = 3.5;
const TRANSCRIPT_CONTEXT_FRACTION = 0.6;

async function runQueryAgainst(
  ctx: Context,
  model: { providerID: string; id: string },
  prompt: string,
): Promise<string> {
  const result = await ctx.generate.text({ model, prompt });
  return result.text.trim();
}

function shortenHome(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

async function currentSessionModel(
  ctx: Context,
  sessionId: string,
): Promise<{ providerID: string; id: string }> {
  try {
    const session = await ctx.session.get({ sessionID: sessionId });
    if (session.model) return session.model;
  } catch {}
  return DEFAULT_MODEL;
}

const listSessionsDescription = `List recorded opencode sessions.

Defaults to sessions for the current project (the session's working directory).
Set all_projects to true to list sessions across every project on this machine.

Use when:
- The user wants to see recent sessions
- You need a session ID to pass to read_session
- The user asks "what sessions do I have" or refers to past work`;

const readSessionDescription = `Read another opencode session and extract only the relevant parts.

This fetches the target session through the V2 API, renders it, then uses a one-shot model request to extract the information described by your query. Works across projects.

Use when:
- A session ID is provided (e.g. from list_sessions)
- You need prior context, decisions, code, or errors from an earlier session
- You want a focused summary rather than the full transcript`;

export default {
  id: "session-tools",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "list_sessions",
        description: listSessionsDescription,
        input: {
          type: "object",
          properties: {
            all_projects: {
              type: "boolean",
              description: "List sessions across all projects (default false)",
            },
            include_children: {
              type: "boolean",
              description: "Include child sessions (default false)",
            },
            limit: {
              type: "integer",
              minimum: 1,
              description: "Maximum sessions (default 25)",
            },
          },
          additionalProperties: false,
        },
        async execute(input) {
          const args = input as {
            all_projects?: boolean;
            include_children?: boolean;
            limit?: number;
          };
          const allProjects = args.all_projects ?? false;
          const scopeLabel = allProjects
            ? "all projects"
            : shortenHome(ctx.location.project.canonical);
          const endpoint = await Service.discover();
          if (!endpoint)
            throw new Error("OpenCode background service not found");
          const client = OpenCode.make({
            baseUrl: endpoint.url,
            headers: Service.headers(endpoint),
          });
          const rows = await client.session.list({
            limit: args.limit ?? 25,
            ...(allProjects ? {} : { project: ctx.location.project.id }),
            ...(!args.include_children ? { parentID: null } : {}),
          });
          if (!rows.data.length) {
            return { content: `No sessions found for ${scopeLabel}.` };
          }

          const lines = rows.data.map((row) => {
            const updated = relativeTime(row.time.updated);
            const title = row.title || "(untitled)";
            const child = row.parentID ? " [child]" : "";
            if (allProjects) {
              return `${row.id}  ${updated.padStart(9)}  ${shortenHome(row.location.directory)}\n    ${title}${child}`;
            }
            return `${row.id}  ${updated.padStart(9)}  ${title}${child}`;
          });
          return {
            content: [
              `Sessions for ${scopeLabel} (${rows.data.length}):`,
              "",
              ...lines,
              "",
              "Use read_session with a session ID to extract details.",
            ].join("\n"),
          };
        },
      });

      editor.add({
        name: "read_session",
        description: readSessionDescription,
        input: {
          type: "object",
          properties: {
            session_id: {
              type: "string",
              description: "The opencode session ID to read",
            },
            query: {
              type: "string",
              description:
                "What to extract from the session, in natural language",
            },
          },
          required: ["session_id", "query"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as { session_id: string; query: string };
          let session;
          try {
            session = await ctx.session.get({ sessionID: args.session_id });
          } catch {
            return { content: `Session ${args.session_id} not found.` };
          }

          await context.progress({ status: `Reading ${args.session_id}` });
          const messages = await ctx.session.context({
            sessionID: args.session_id,
          });
          const rendered = renderSessionBlocks(messages, {
            perPartTruncation: PER_PART_TRUNCATION,
            title: session.title ?? "(untitled)",
            directory: session.location.directory,
          });

          if (rendered.blocks.length === 0) {
            return {
              content: `Session ${args.session_id} has no readable content.`,
            };
          }

          const transcript = [rendered.header, "", ...rendered.blocks].join(
            "\n\n",
          );
          const model = await currentSessionModel(ctx, context.sessionID);
          const contextTokens = await modelContextTokens(ctx, model);
          const budgetChars = Math.floor(
            contextTokens * TRANSCRIPT_CONTEXT_FRACTION * CHARS_PER_TOKEN,
          );

          const singleQueryPrompt = (transcriptText: string) =>
            [
              "You are extracting relevant context from a previous opencode session.",
              "",
              "QUERY (what to extract):",
              args.query,
              "",
              "RULES:",
              "- Answer the query using only the session transcript below.",
              "- Preserve decisions, code, file paths, constraints, errors, and their fixes.",
              "- Drop noise and repetition. Be concise but complete.",
              "- If the transcript does not contain the answer, say so plainly.",
              "",
              "SESSION TRANSCRIPT:",
              transcriptText,
            ].join("\n");

          if (transcript.length <= budgetChars) {
            const text = await runQueryAgainst(
              ctx,
              model,
              singleQueryPrompt(transcript),
            );

            return {
              content: text || "The extraction session returned no answer.",
              metadata: {
                session_id: args.session_id,
                transcript_chars: transcript.length,
                chunks: 1,
                model: `${model.providerID}/${model.id}`,
              },
            };
          }

          const chunks = chunkBlocks(rendered, budgetChars);
          const partials: string[] = [];
          for (let i = 0; i < chunks.length; i++) {
            await context.progress({
              status: `Reading ${args.session_id} (part ${i + 1}/${chunks.length})`,
            });
            const partPrompt = [
              `You are reading part ${i + 1} of ${chunks.length} of a previous opencode session.`,
              "This is only a portion of the full session.",
              "",
              "QUERY (what to extract):",
              args.query,
              "",
              "RULES:",
              "- Extract only what is relevant to the query from THIS part.",
              "- Preserve decisions, code, file paths, constraints, errors, and their fixes.",
              "- If this part contains nothing relevant, reply exactly: NOTHING RELEVANT.",
              "",
              "SESSION TRANSCRIPT (part):",
              chunks[i],
            ].join("\n");

            const answer = await runQueryAgainst(ctx, model, partPrompt);
            if (answer && answer.trim() !== "NOTHING RELEVANT") {
              partials.push(
                `--- Part ${i + 1}/${chunks.length} ---\n${answer}`,
              );
            }
          }

          if (partials.length === 0) {
            return {
              content:
                "No relevant content found across the session for that query.",
            };
          }

          const combined = partials.join("\n\n");
          const reducePrompt = [
            "You are combining partial extractions from different parts of one opencode session.",
            "",
            "QUERY (what the user asked for):",
            args.query,
            "",
            "RULES:",
            "- Merge the partial findings below into one coherent answer to the query.",
            "- Resolve overlap and drop repetition. Keep code, file paths, decisions, and errors.",
            "- Do not invent anything not present in the partials.",
            "",
            "PARTIAL FINDINGS:",
            combined,
          ].join("\n");

          const final = await runQueryAgainst(ctx, model, reducePrompt);

          return {
            content: final || combined,
            metadata: {
              session_id: args.session_id,
              transcript_chars: transcript.length,
              chunks: chunks.length,
              model: `${model.providerID}/${model.id}`,
            },
          };
        },
      });
    });
  },
} satisfies Plugin;
