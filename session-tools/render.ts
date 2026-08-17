import type { MessageRow, PartRow } from "./db.ts"

type ParsedMessage = {
  role: string
  agent?: string
  created: number
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  const omitted = text.length - max
  return `${text.slice(0, max)}\n... [${omitted} more characters truncated]`
}

function formatToolInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

export type RenderedSession = {
  header: string
  blocks: string[]
}

export function renderSessionBlocks(
  messages: MessageRow[],
  parts: PartRow[],
  opts: { perPartTruncation: number; title: string; directory: string },
): RenderedSession {
  const partsByMessage = new Map<string, PartRow[]>()
  for (const part of parts) {
    const list = partsByMessage.get(part.message_id)
    if (list) list.push(part)
    else partsByMessage.set(part.message_id, [part])
  }

  const header = `# Session: ${opts.title}\nDirectory: ${opts.directory}`
  const blocks: string[] = []

  for (const message of messages) {
    let parsed: ParsedMessage
    try {
      const data = JSON.parse(message.data)
      parsed = { role: data.role ?? "unknown", agent: data.agent, created: message.time_created }
    } catch {
      parsed = { role: "unknown", created: message.time_created }
    }

    const messageParts = partsByMessage.get(message.id) ?? []
    const rendered = renderParts(messageParts, opts.perPartTruncation)
    if (!rendered.trim()) continue

    const heading = parsed.agent ? `${parsed.role} (${parsed.agent})` : parsed.role
    blocks.push(`## ${heading}\n${rendered}`)
  }

  return { header, blocks }
}

export function renderSession(
  messages: MessageRow[],
  parts: PartRow[],
  opts: { perPartTruncation: number; title: string; directory: string },
): string {
  const { header, blocks } = renderSessionBlocks(messages, parts, opts)
  return [header, "", ...blocks.flatMap((block) => [block, ""])].join("\n")
}

export function chunkBlocks(
  rendered: RenderedSession,
  maxChars: number,
): string[] {
  const { header, blocks } = rendered
  if (blocks.length === 0) return []

  const chunks: string[] = []
  let current: string[] = []
  let currentLen = header.length

  const flush = () => {
    if (current.length === 0) return
    chunks.push([header, "", ...current].join("\n\n"))
    current = []
    currentLen = header.length
  }

  for (const block of blocks) {
    // A single block can exceed the budget; hard-split it on its own.
    if (block.length > maxChars) {
      flush()
      for (let i = 0; i < block.length; i += maxChars) {
        chunks.push([header, "", block.slice(i, i + maxChars)].join("\n\n"))
      }
      continue
    }
    if (currentLen + block.length + 2 > maxChars) flush()
    current.push(block)
    currentLen += block.length + 2
  }
  flush()

  return chunks
}

function renderParts(parts: PartRow[], perPartTruncation: number): string {
  const chunks: string[] = []

  for (const part of parts) {
    let data: any
    try {
      data = JSON.parse(part.data)
    } catch {
      continue
    }

    switch (data.type) {
      case "text": {
        if (data.synthetic) continue
        const text = typeof data.text === "string" ? data.text.trim() : ""
        if (text) chunks.push(text)
        break
      }
      case "tool": {
        const state = data.state ?? {}
        if (state.status !== "completed" && state.status !== "error") {
          // skip pending / running noise
        }
        const input = formatToolInput(state.input)
        const inputLine = input ? ` ${truncate(input, 500)}` : ""
        chunks.push(`\`\`\`tool: ${data.tool}${inputLine}`)
        if (state.status === "error" && state.error) {
          chunks.push(`error: ${truncate(String(state.error), perPartTruncation)}`)
        } else if (typeof state.output === "string" && state.output.trim()) {
          chunks.push(truncate(state.output, perPartTruncation))
        }
        chunks.push("```")
        break
      }
      case "reasoning":
      case "step-start":
      case "step-finish":
      case "patch":
        // noise: skip
        break
      default:
        break
    }
  }

  return chunks.join("\n\n")
}
