// Standalone proxy server -- spawned as a detached process by the plugin.
// Intercepts LM Studio responses and moves tool calls from reasoning_content
// into proper tool_calls structures.

process.on("uncaughtException", (err) => {
  Bun.write("/tmp/lmstudio-proxy-error.log", `${new Date().toISOString()} uncaughtException: ${err?.stack || err}\n`, { append: true })
})
process.on("unhandledRejection", (err: any) => {
  Bun.write("/tmp/lmstudio-proxy-error.log", `${new Date().toISOString()} unhandledRejection: ${err?.stack || err}\n`, { append: true })
})

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
  error(err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 })
  },
  async fetch(req) {
    try {
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
    let toolCallStreaming = false
    let toolCallComplete = false
    let templateChunk: any = null
    let lineBuffer = ""
    let hasContent = false
    let toolCallId = ""
    let emittedArgs = ""
    let toolCallIndex = 0

    function emitChunk(ctrl: ReadableStreamDefaultController, data: any) {
      ctrl.enqueue(encoder.encode("data: " + JSON.stringify(data) + "\n\n"))
    }

    function getBase() {
      return templateChunk || {
        id: "proxy",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "proxy",
      }
    }

    // State machine for parsing XML tool calls incrementally
    // States: idle -> sawFunction -> inParam -> done
    let parseState: "idle" | "sawFunction" | "inParam" | "done" = "idle"
    let parsedName = ""
    let currentParamName = ""
    let paramCount = 0
    let scanPos = 0 // how far we've scanned in reasoningBuffer

    function emitToolName(ctrl: ReadableStreamDefaultController, name: string) {
      toolCallStreaming = true
      toolCallId = `proxy_call_${++callCounter}`
      parsedName = name

      emitChunk(ctrl, {
        ...getBase(),
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: toolCallIndex,
              id: toolCallId,
              type: "function",
              function: { name, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      })
    }

    function emitArgDelta(ctrl: ReadableStreamDefaultController, delta: string) {
      emitChunk(ctrl, {
        ...getBase(),
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: toolCallIndex,
              function: { arguments: delta },
            }],
          },
          finish_reason: null,
        }],
      })
    }

    function emitParam(ctrl: ReadableStreamDefaultController, key: string, value: string) {
      // Build a JSON fragment that concatenates with previous ones
      // First param: '{"key":"value"'   (open brace, no close)
      // Subsequent:  ',"key":"value"'   (comma-separated)
      const escapedValue = JSON.stringify(value)
      const prefix = paramCount === 0 ? "{" : ","
      const fragment = `${prefix}${JSON.stringify(key)}:${escapedValue}`
      paramCount++
      emitArgDelta(ctrl, fragment)
    }

    function tryParseIncremental(ctrl: ReadableStreamDefaultController) {
      if (!toolCallDetected) return

      const buf = reasoningBuffer

      while (scanPos < buf.length) {
        if (parseState === "idle") {
          // Look for <function=name>
          const funcIdx = buf.indexOf("<function=", scanPos)
          if (funcIdx === -1) break
          const closeIdx = buf.indexOf(">", funcIdx + 10)
          if (closeIdx === -1) break

          const name = buf.slice(funcIdx + 10, closeIdx)
          parseState = "sawFunction"
          scanPos = closeIdx + 1
          emitToolName(ctrl, name)
          continue
        }

        if (parseState === "sawFunction" || parseState === "inParam") {
          // Check for </function> first (end of params)
          const funcEndIdx = buf.indexOf("</function>", scanPos)
          const paramIdx = buf.indexOf("<parameter=", scanPos)

          // If </function> comes before next param (or no more params), we're done
          if (funcEndIdx !== -1 && (paramIdx === -1 || funcEndIdx < paramIdx)) {
            // Close the arguments JSON
            if (paramCount > 0) {
              emitArgDelta(ctrl, "}")
            } else {
              emitArgDelta(ctrl, "{}")
            }
            parseState = "done"
            scanPos = funcEndIdx + 11
            break
          }

          if (paramIdx === -1) break
          const paramCloseIdx = buf.indexOf(">", paramIdx + 11)
          if (paramCloseIdx === -1) break

          const paramName = buf.slice(paramIdx + 11, paramCloseIdx)
          currentParamName = paramName

          // Now find the closing </parameter>
          const paramEndIdx = buf.indexOf("</parameter>", paramCloseIdx + 1)
          if (paramEndIdx === -1) {
            // Haven't received the full value yet
            parseState = "inParam"
            break
          }

          // Extract value between > and </parameter>, strip leading/trailing newlines
          let value = buf.slice(paramCloseIdx + 1, paramEndIdx)
          if (value.startsWith("\n")) value = value.slice(1)
          if (value.endsWith("\n")) value = value.slice(0, -1)

          emitParam(ctrl, currentParamName, value)
          parseState = "sawFunction"
          scanPos = paramEndIdx + 12
          continue
        }

        break
      }
    }

    function finishToolCall(ctrl: ReadableStreamDefaultController) {
      if (toolCallComplete) return

      // Try to parse anything remaining
      tryParseIncremental(ctrl)

      // If we never started streaming, try the full parser as fallback
      if (!toolCallStreaming) {
        const toolCalls = parseToolCalls(reasoningBuffer)
        if (toolCalls.length > 0) {
          const tc = toolCalls[0]
          emitToolName(ctrl, tc.name)
          emitArgDelta(ctrl, tc.arguments)
        }
      } else if (parseState !== "done") {
        // Parser didn't finish cleanly -- close the args JSON if we started it
        if (paramCount > 0) {
          emitArgDelta(ctrl, "}")
        } else {
          emitArgDelta(ctrl, "{}")
        }
      }

      toolCallComplete = true

      emitChunk(ctrl, {
        ...getBase(),
        choices: [{
          index: 0,
          delta: {},
          finish_reason: "tool_calls",
        }],
      })
    }

    const stream = new ReadableStream({
      async pull(controller) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            if (toolCallDetected && !toolCallComplete) finishToolCall(controller)
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
              if (toolCallDetected && !toolCallComplete) finishToolCall(controller)
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
                scanPos = 0
                tryParseIncremental(controller)
                continue
              }

              if (toolCallDetected) {
                tryParseIncremental(controller)
                if (reasoningBuffer.includes("</tool_call>")) finishToolCall(controller)
                continue
              }

              controller.enqueue(encoder.encode(line + "\n"))
              continue
            }

            if (delta.content !== undefined) {
              if (delta.content.trim()) hasContent = true
              if (toolCallDetected && !toolCallComplete) finishToolCall(controller)
              controller.enqueue(encoder.encode(line + "\n"))
              continue
            }

            if (chunk.choices?.[0]?.finish_reason) {
              if (toolCallDetected && !toolCallComplete && reasoningBuffer.includes("</tool_call>")) {
                finishToolCall(controller)
              }

              if (toolCallComplete) {
                // Don't forward the original finish chunk -- we already emitted ours
                continue
              } else if (!hasContent && !toolCallDetected && reasoningBuffer.trim() && chunk.choices[0].finish_reason === "stop") {
                // Model only produced reasoning with no content -- emit reasoning as content
                const base = getBase()
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
      },
    })

    return new Response(stream, {
      status: upstreamRes.status,
      headers: Object.fromEntries(upstreamRes.headers.entries()),
    })
    } catch (err: any) {
      Bun.write("/tmp/lmstudio-proxy-error.log", `${new Date().toISOString()} fetch error: ${err?.stack || err}\n`, { append: true })
      return new Response(`Proxy error: ${err?.message || "unknown"}`, { status: 502 })
    }
  },
})


