import { tool, type Plugin, type PluginInput } from "@opencode-ai/plugin"
import {
  openDb,
  listSessions as dbListSessions,
  getProjectForDirectory,
  getSession,
  getMessages,
  getParts,
} from "./db.ts"
import { renderSessionBlocks, chunkBlocks } from "./render.ts"
import { modelContextTokens } from "./context.ts"

const DEFAULT_MODEL = { providerID: "anthropic", modelID: "claude-haiku-4-5" }
const PER_PART_TRUNCATION = 4000

// Rough chars-per-token for budgeting. Deliberately low so we under-fill.
const CHARS_PER_TOKEN = 3.5
// Fraction of the model's context we let the transcript occupy, leaving room
// for the prompt scaffolding, the model's reasoning, and its answer.
const TRANSCRIPT_CONTEXT_FRACTION = 0.6

async function runQueryAgainst(
  input: PluginInput,
  opts: {
    parentSessionID: string
    directory: string
    model: { providerID: string; modelID: string }
    title: string
    prompt: string
  },
): Promise<string> {
  const created = await input.client.session.create({
    body: { parentID: opts.parentSessionID, title: opts.title },
    query: { directory: opts.directory },
  })
  const subSessionId = created.data?.id
  if (!subSessionId) throw new Error("failed to create sub-session")

  const result = await input.client.session.prompt({
    path: { id: subSessionId },
    body: { model: opts.model, parts: [{ type: "text", text: opts.prompt }] },
  })

  const parts = result.data?.parts ?? []
  return parts
    .filter((part: any) => part.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("")
    .trim()
}

function shortenHome(path: string): string {
  const home = process.env.HOME
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`
  return path
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return "just now"
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

async function currentSessionModel(
  input: PluginInput,
  sessionId: string,
): Promise<{ providerID: string; modelID: string }> {
  try {
    const result = await input.client.session.messages({ path: { id: sessionId } })
    const messages = result.data ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info as any
      if (info?.role === "assistant" && info.providerID && info.modelID) {
        return { providerID: info.providerID, modelID: info.modelID }
      }
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_MODEL
}

const listSessionsTool = tool({
  description: `List recorded opencode sessions from the local session database.

Defaults to sessions for the current project (the session's working directory).
Set all_projects to true to list sessions across every project on this machine.

Use when:
- The user wants to see recent sessions
- You need a session ID to pass to read_session
- The user asks "what sessions do I have" or refers to past work`,
  args: {
    all_projects: tool.schema
      .boolean()
      .optional()
      .describe("List sessions across all projects instead of just the current one (default false)"),
    include_children: tool.schema
      .boolean()
      .optional()
      .describe("Include child/sub-agent sessions (default false)"),
    limit: tool.schema
      .number()
      .optional()
      .describe("Maximum number of sessions to return (default 25)"),
  },
  async execute(args, context) {
    const db = openDb()
    const limit = args.limit ?? 25
    const allProjects = args.all_projects ?? false
    const includeChildren = args.include_children ?? false

    let projectId: string | undefined
    let scopeLabel = "all projects"
    if (!allProjects) {
      const project = getProjectForDirectory(db, context.directory)
      if (!project) {
        return `No project found for ${context.directory}. Pass all_projects: true to list across every project.`
      }
      projectId = project.id
      scopeLabel = project.name || shortenHome(project.worktree)
    }

    const rows = dbListSessions(db, { projectId, limit, includeChildren })
    if (rows.length === 0) {
      return `No sessions found for ${scopeLabel}.`
    }

    const lines = rows.map((row) => {
      const updated = relativeTime(row.time_updated)
      const dir = shortenHome(row.directory)
      const title = row.title || "(untitled)"
      const child = row.parent_id ? " [child]" : ""
      if (allProjects) {
        return `${row.id}  ${updated.padStart(9)}  ${dir}\n    ${title}${child}`
      }
      return `${row.id}  ${updated.padStart(9)}  ${title}${child}`
    })

    return [
      `Sessions for ${scopeLabel} (${rows.length}):`,
      "",
      ...lines,
      "",
      "Use read_session with a session ID to extract details.",
    ].join("\n")
  },
})

function makeReadSessionTool(input: PluginInput) {
  return tool({
    description: `Read another opencode session from the local session database and extract only the relevant parts.

This reads the target session directly from sqlite, renders it, then spawns a sub-session whose LLM extracts the information described by your query. Works across projects.

Use when:
- A session ID is provided (e.g. from list_sessions)
- You need prior context, decisions, code, or errors from an earlier session
- You want a focused summary rather than the full transcript`,
    args: {
      session_id: tool.schema
        .string()
        .describe("The opencode session ID to read (e.g. ses_abc123...)"),
      query: tool.schema
        .string()
        .describe("What to extract from the session, in natural language"),
    },
    async execute(args, context) {
      const db = openDb()
      const session = getSession(db, args.session_id)
      if (!session) {
        return `Session ${args.session_id} not found in the local database.`
      }

      context.metadata({
        title: `Reading ${args.session_id}`,
        metadata: { session_id: args.session_id, directory: session.directory },
      })

      const messages = getMessages(db, args.session_id)
      const parts = getParts(db, args.session_id)
      const rendered = renderSessionBlocks(messages, parts, {
        perPartTruncation: PER_PART_TRUNCATION,
        title: session.title,
        directory: session.directory,
      })

      if (rendered.blocks.length === 0) {
        return `Session ${args.session_id} has no readable content.`
      }

      const transcript = [rendered.header, "", ...rendered.blocks].join("\n\n")
      const model = await currentSessionModel(input, context.sessionID)
      const contextTokens = await modelContextTokens(input, model)
      const budgetChars = Math.floor(contextTokens * TRANSCRIPT_CONTEXT_FRACTION * CHARS_PER_TOKEN)

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
        ].join("\n")

      // Fits in one pass: single sub-session, same as before.
      if (transcript.length <= budgetChars) {
        const text = await runQueryAgainst(input, {
          parentSessionID: context.sessionID,
          directory: context.directory,
          model,
          title: `Reading session ${args.session_id}`,
          prompt: singleQueryPrompt(transcript),
        })

        context.metadata({
          title: `Read ${args.session_id}`,
          metadata: {
            session_id: args.session_id,
            transcript_chars: transcript.length,
            chunks: 1,
            model: `${model.providerID}/${model.modelID}`,
          },
        })

        return text || "The sub-session returned no answer."
      }

      // Too big: map over chunks, each in a fresh sub-session, then reduce.
      const chunks = chunkBlocks(rendered, budgetChars)
      const partials: string[] = []
      for (let i = 0; i < chunks.length; i++) {
        context.metadata({
          title: `Reading ${args.session_id} (part ${i + 1}/${chunks.length})`,
          metadata: { session_id: args.session_id, chunk: i + 1, chunks: chunks.length },
        })
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
        ].join("\n")

        const answer = await runQueryAgainst(input, {
          parentSessionID: context.sessionID,
          directory: context.directory,
          model,
          title: `Reading session ${args.session_id} (${i + 1}/${chunks.length})`,
          prompt: partPrompt,
        })
        if (answer && answer.trim() !== "NOTHING RELEVANT") {
          partials.push(`--- Part ${i + 1}/${chunks.length} ---\n${answer}`)
        }
      }

      if (partials.length === 0) {
        context.metadata({
          title: `Read ${args.session_id}`,
          metadata: {
            session_id: args.session_id,
            transcript_chars: transcript.length,
            chunks: chunks.length,
            model: `${model.providerID}/${model.modelID}`,
          },
        })
        return "No relevant content found across the session for that query."
      }

      // Reduce: combine the partial extractions into one coherent answer.
      const combined = partials.join("\n\n")
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
      ].join("\n")

      const final = await runQueryAgainst(input, {
        parentSessionID: context.sessionID,
        directory: context.directory,
        model,
        title: `Combining session ${args.session_id}`,
        prompt: reducePrompt,
      })

      context.metadata({
        title: `Read ${args.session_id}`,
        metadata: {
          session_id: args.session_id,
          transcript_chars: transcript.length,
          chunks: chunks.length,
          model: `${model.providerID}/${model.modelID}`,
        },
      })

      return final || combined
    },
  })
}

export const SessionTools: Plugin = async (input) => {
  return {
    tool: {
      list_sessions: listSessionsTool,
      read_session: makeReadSessionTool(input),
    },
  }
}

export default SessionTools
