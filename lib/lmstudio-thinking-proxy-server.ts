// Standalone proxy server -- spawned as a detached process by the plugin.
// Intercepts LM Studio responses and moves tool calls from reasoning_content
// into proper tool_calls structures.

const UPSTREAM = process.argv[2]
const PORT = parseInt(process.argv[3] || "11435")

if (!UPSTREAM) {
  process.exit(1)
}

let callCounter = 0

function parseToolCalls(raw: string): Array<{ name: string; arguments: string }> {
  const results: Array<{ name: string; arguments: string }> = []
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let match
  while ((match = regex.exec(raw)) !== null) {
    try {
      const inner = match[1].trim()

      // Try JSON format: {"name": "...", "arguments": {...}}
      try {
        const parsed = JSON.parse(inner)
        const name = parsed.name || ""
        const args = typeof parsed.arguments === "string"
          ? parsed.arguments
          : JSON.stringify(parsed.arguments || {})
        results.push({ name, arguments: args })
        continue
      } catch {}

      // Fall back to XML format: <function=name><parameter=key>value</parameter></function>
      const funcMatch = inner.match(/<function=([^>]+)>([\s\S]*?)<\/function>/)
      if (funcMatch) {
        const name = funcMatch[1]
        const paramsStr = funcMatch[2]
        const paramRegex = /<parameter=([^>]+)>\n?([\s\S]*?)\n?<\/parameter>/g
        const params: Record<string, string> = {}
        let pm
        while ((pm = paramRegex.exec(paramsStr)) !== null) {
          params[pm[1]] = pm[2].replace(/^\n|\n$/g, "")
        }
        results.push({ name, arguments: JSON.stringify(params) })
      }
    } catch {}
  }
  return results
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const upstream = `${UPSTREAM}${url.pathname}${url.search}`
    const isChatCompletion = url.pathname === "/v1/chat/completions"

    let body: any = null
    let isStreaming = false

    if (req.method === "POST" && isChatCompletion) {
      body = await req.json()
      isStreaming = body.stream === true
    }

    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      if (k !== "host") headers[k] = v
    })

    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: body ? JSON.stringify(body) : req.body,
    })

    if (!isChatCompletion) {
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: Object.fromEntries(upstreamRes.headers.entries()),
      })
    }

    if (!isStreaming) {
      const data = await upstreamRes.json() as any

      for (const choice of data.choices || []) {
        const msg = choice.message
        if (!msg?.reasoning_content) continue

        const toolCalls = parseToolCalls(msg.reasoning_content)

        if (toolCalls.length > 0) {
          msg.reasoning_content = msg.reasoning_content
            .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
            .trimEnd()

          if (!msg.tool_calls || msg.tool_calls.length === 0) {
            msg.tool_calls = toolCalls.map((tc) => ({
              id: `proxy_call_${++callCounter}`,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            }))
            choice.finish_reason = "tool_calls"
          }
        } else if ((!msg.content || !msg.content.trim()) && choice.finish_reason === "stop") {
          // Model put its entire response in reasoning with no content -- move it
          msg.content = msg.reasoning_content
          msg.reasoning_content = ""
        }
      }

      return Response.json(data, {
        status: upstreamRes.status,
        headers: Object.fromEntries(upstreamRes.headers.entries()),
      })
    }

    // Streaming
    const reader = upstreamRes.body!.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    let reasoningBuffer = ""
    let toolCallDetected = false
    let flushedToolCall = false
    let templateChunk: any = null
    let lineBuffer = ""
    let hasContent = false

    const stream = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            if (toolCallDetected && !flushedToolCall) flush(controller)
            controller.close()
            return
          }

          const text = lineBuffer + decoder.decode(value, { stream: true })
          const lines = text.split("\n")

          // Last element might be incomplete -- carry it over
          lineBuffer = lines.pop() || ""

          for (const line of lines) {
            if (!line.startsWith("data: ")) {
              if (line.trim()) controller.enqueue(encoder.encode(line + "\n"))
              else controller.enqueue(encoder.encode("\n"))
              continue
            }

            if (line === "data: [DONE]") {
              if (toolCallDetected && !flushedToolCall) flush(controller)
              controller.enqueue(encoder.encode(line + "\n"))
              continue
            }

            let chunk: any
            try {
              chunk = JSON.parse(line.slice(6))
            } catch {
              controller.enqueue(encoder.encode(line + "\n"))
              continue
            }

            if (!templateChunk) templateChunk = JSON.parse(JSON.stringify(chunk))

            const delta = chunk.choices?.[0]?.delta
            if (!delta) {
              controller.enqueue(encoder.encode(line + "\n"))
              continue
            }

            if (delta.reasoning_content !== undefined) {
              reasoningBuffer += delta.reasoning_content

              if (!toolCallDetected && reasoningBuffer.includes("<tool_call>")) {
                toolCallDetected = true
                const idx = reasoningBuffer.indexOf("<tool_call>")
                const before = reasoningBuffer.slice(0, idx)
                if (before) {
                  delta.reasoning_content = before
                  controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"))
                }
                reasoningBuffer = reasoningBuffer.slice(idx)
                continue
              }

              if (toolCallDetected) {
                if (reasoningBuffer.includes("</tool_call>")) flush(controller)
                continue
              }

              controller.enqueue(encoder.encode(line + "\n"))
              continue
            }

            if (delta.content !== undefined) {
              if (delta.content.trim()) hasContent = true
              if (toolCallDetected && !flushedToolCall) flush(controller)
              controller.enqueue(encoder.encode(line + "\n"))
              continue
            }

            if (chunk.choices?.[0]?.finish_reason) {
              if (flushedToolCall) {
                chunk.choices[0].finish_reason = "tool_calls"
              } else if (!hasContent && !toolCallDetected && reasoningBuffer.trim() && chunk.choices[0].finish_reason === "stop") {
                // Model only produced reasoning with no content -- emit reasoning as content
                const base = templateChunk || chunk
                controller.enqueue(encoder.encode("data: " + JSON.stringify({
                  ...base,
                  choices: [{
                    index: 0,
                    delta: { content: reasoningBuffer.trim() },
                    finish_reason: null,
                  }],
                }) + "\n\n"))
              }
            }

            controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"))
          }
        }

        function flush(ctrl: ReadableStreamDefaultController) {
          if (flushedToolCall) return
          flushedToolCall = true

          const toolCalls = parseToolCalls(reasoningBuffer)
          if (toolCalls.length === 0) return

          const base = templateChunk || {
            id: "proxy",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "proxy",
          }

          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i]
            ctrl.enqueue(encoder.encode("data: " + JSON.stringify({
              ...base,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: i,
                    id: `proxy_call_${++callCounter}`,
                    type: "function",
                    function: { name: tc.name, arguments: tc.arguments },
                  }],
                },
                finish_reason: null,
              }],
            }) + "\n\n"))
          }

          ctrl.enqueue(encoder.encode("data: " + JSON.stringify({
            ...base,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: "tool_calls",
            }],
          }) + "\n\n"))
        }
      },
    })

    return new Response(stream, {
      status: upstreamRes.status,
      headers: Object.fromEntries(upstreamRes.headers.entries()),
    })
  },
})


