// Standalone proxy server -- spawned as a detached process by the plugin.
// Intercepts LM Studio responses and moves tool calls from reasoning_content
// into proper tool_calls structures.

import { appendFileSync, mkdirSync } from "fs"

const DEBUG = process.env.PROXY_DEBUG === "1"
const LOG_DIR = (process.env.HOME || "/tmp") + "/.opencode/logs/proxy"
if (DEBUG) mkdirSync(LOG_DIR, { recursive: true })

function serverLog(msg: string) {
  if (!DEBUG) return
  appendFileSync(`${LOG_DIR}/server.log`, `${new Date().toISOString()} ${msg}\n`)
}

process.on("uncaughtException", (err) => {
  serverLog(`uncaughtException: ${err?.stack || err}`)
})
process.on("unhandledRejection", (err: any) => {
  serverLog(`unhandledRejection: ${err?.stack || err}`)
})

const UPSTREAM = process.argv[2]
const PORT = parseInt(process.argv[3] || "11435")

if (!UPSTREAM) {
  process.exit(1)
}

let callCounter = 0

// Tool calls arrive embedded in reasoning text using this shape:
//
//   <tool_call>
//     <function=read>
//       <parameter=filePath>
//         /etc/hosts
//       </parameter>
//     </function>
//   </tool_call>
//
// The lexer below produces a flat token stream; the parser walks tokens and
// builds tool call objects. Anything that doesn't fit the grammar is silently
// skipped so partial or malformed blocks don't break the whole response.

type Token =
  | { kind: "openToolCall"; start: number; end: number }
  | { kind: "closeToolCall"; start: number; end: number }
  | { kind: "openFunction"; name: string; start: number; end: number }
  | { kind: "closeFunction"; start: number; end: number }
  | { kind: "openParam"; name: string; start: number; end: number }
  | { kind: "closeParam"; start: number; end: number }
  | { kind: "text"; value: string; start: number; end: number }

// Tags that could partially match if the input is truncated mid-stream. If the
// tail of the buffer begins one of these without completing it, the tokenizer
// reports the boundary so the streaming code knows not to release that region
// yet.
const ALL_TAGS = ["<tool_call>", "</tool_call>", "<function=", "</function>", "<parameter=", "</parameter>"]

// Returns the start offset of a possibly-partial tag at the tail of `input`,
// or -1 if no partial tag is hanging.
function tailPartialTagStart(input: string): number {
  // Walk back up to the longest tag length and check if any tag is a prefix
  // of input[k..]. We only care about non-empty prefixes that aren't already
  // the complete tag.
  const maxTagLen = Math.max(...ALL_TAGS.map((t) => t.length))
  const start = Math.max(0, input.length - maxTagLen + 1)
  for (let k = start; k < input.length; k++) {
    if (input[k] !== "<") continue
    const tail = input.slice(k)
    for (const tag of ALL_TAGS) {
      if (tag.startsWith(tail) && tail !== tag) return k
    }
    // Also: an opener like <function= or <parameter= that's complete but
    // hasn't reached its closing `>` yet -- the tokenizer can't emit it.
    for (const tag of ["<function=", "<parameter="]) {
      if (tail.startsWith(tag) && !tail.includes(">", tag.length)) return k
    }
  }
  return -1
}

interface TokenizeResult {
  tokens: Token[]
  // The byte offset past which the input is still ambiguous (partial tag, or
  // inside an unclosed <parameter=...>). Equal to input.length when the whole
  // string has been parsed cleanly.
  consumedUpTo: number
}

function tokenize(input: string): TokenizeResult {
  const tokens: Token[] = []
  let i = 0
  let textStart = 0
  // Once we're inside a <parameter=...> body, the only structural tags we
  // recognise are <parameter=...> (depth++) and </parameter> (depth--).
  // Everything else -- including nested <tool_call> blocks -- is treated as
  // part of the parameter value. Tracking depth means a tool call can embed
  // another <parameter=...></parameter> pair in its value without the inner
  // closer ending the outer parameter prematurely.
  let paramDepth = 0
  // Position of the most recent <parameter=...> opener that's still unclosed.
  // Used as the consumed boundary when the buffer ends mid-parameter.
  let outermostParamOpenAt = -1

  function flushText(end: number) {
    if (end > textStart) {
      tokens.push({ kind: "text", value: input.slice(textStart, end), start: textStart, end })
    }
  }

  while (i < input.length) {
    if (input[i] !== "<") { i++; continue }

    if (paramDepth > 0) {
      if (input.startsWith("</parameter>", i)) {
        paramDepth--
        if (paramDepth === 0) {
          flushText(i)
          tokens.push({ kind: "closeParam", start: i, end: i + "</parameter>".length })
          i += "</parameter>".length
          textStart = i
          outermostParamOpenAt = -1
          continue
        }
        i += "</parameter>".length
        continue
      }
      if (input.startsWith("<parameter=", i)) {
        const end = input.indexOf(">", i + "<parameter=".length)
        if (end === -1) { i++; continue }
        paramDepth++
        i = end + 1
        continue
      }
      i++
      continue
    }

    let matched = false
    const tagStart = i

    if (input.startsWith("<tool_call>", i)) {
      flushText(i)
      const end = i + "<tool_call>".length
      tokens.push({ kind: "openToolCall", start: i, end })
      i = end
      textStart = i
      matched = true
    } else if (input.startsWith("</tool_call>", i)) {
      flushText(i)
      const end = i + "</tool_call>".length
      tokens.push({ kind: "closeToolCall", start: i, end })
      i = end
      textStart = i
      matched = true
    } else if (input.startsWith("</function>", i)) {
      flushText(i)
      const end = i + "</function>".length
      tokens.push({ kind: "closeFunction", start: i, end })
      i = end
      textStart = i
      matched = true
    } else if (input.startsWith("<function=", i)) {
      const nameEnd = input.indexOf(">", i + "<function=".length)
      if (nameEnd !== -1) {
        flushText(i)
        const end = nameEnd + 1
        tokens.push({ kind: "openFunction", name: input.slice(i + "<function=".length, nameEnd), start: i, end })
        i = end
        textStart = i
        matched = true
      }
    } else if (input.startsWith("<parameter=", i)) {
      const nameEnd = input.indexOf(">", i + "<parameter=".length)
      if (nameEnd !== -1) {
        flushText(i)
        const end = nameEnd + 1
        tokens.push({ kind: "openParam", name: input.slice(i + "<parameter=".length, nameEnd), start: i, end })
        paramDepth++
        outermostParamOpenAt = tagStart
        i = end
        textStart = i
        matched = true
      }
    }

    if (!matched) i++
  }

  flushText(input.length)

  // Figure out how much of the input we've consumed unambiguously:
  // - If we ended inside a parameter body, the safe boundary is the start of
  //   that parameter's opener (more input could change its value).
  // - Else if the tail contains a partial tag, the safe boundary is the tag start.
  // - Else, the whole input.
  let consumedUpTo: number
  if (paramDepth > 0 && outermostParamOpenAt !== -1) {
    consumedUpTo = outermostParamOpenAt
  } else {
    const partial = tailPartialTagStart(input)
    consumedUpTo = partial === -1 ? input.length : partial
  }

  return { tokens, consumedUpTo }
}

function coerce(raw: string): any {
  const stripped = raw.replace(/^\n|\n$/g, "")
  const trimmed = stripped.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
    try { return JSON.parse(trimmed) } catch {}
  }
  return stripped
}

function parseToolCalls(raw: string): Array<{ name: string; arguments: string }> {
  const { tokens } = tokenize(raw)
  const results: Array<{ name: string; arguments: string }> = []

  let pos = 0
  while (pos < tokens.length) {
    if (tokens[pos].kind !== "openToolCall") { pos++; continue }
    pos++ // consume openToolCall

    let funcName: string | null = null
    const params: Record<string, any> = {}

    while (pos < tokens.length && tokens[pos].kind !== "closeToolCall") {
      const t = tokens[pos]

      if (t.kind === "openFunction") {
        funcName = t.name
        pos++
        while (pos < tokens.length && tokens[pos].kind !== "closeFunction" && tokens[pos].kind !== "closeToolCall") {
          const p = tokens[pos]
          if (p.kind === "openParam") {
            const paramName = p.name
            pos++
            // Collect text up to </parameter>. We allow nested unrelated tokens
            // by stringifying them back -- but in practice the inner content is
            // always plain text.
            let valueParts: string[] = []
            while (pos < tokens.length && tokens[pos].kind !== "closeParam" && tokens[pos].kind !== "closeFunction" && tokens[pos].kind !== "closeToolCall") {
              const v = tokens[pos]
              if (v.kind === "text") valueParts.push(v.value)
              pos++
            }
            params[paramName] = coerce(valueParts.join(""))
            if (pos < tokens.length && tokens[pos].kind === "closeParam") pos++
          } else {
            pos++
          }
        }
        if (pos < tokens.length && tokens[pos].kind === "closeFunction") pos++
      } else {
        pos++
      }
    }
    if (pos < tokens.length && tokens[pos].kind === "closeToolCall") pos++

    if (funcName) {
      results.push({ name: funcName, arguments: JSON.stringify(params) })
    }
  }

  return results
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // max value; prevents Bun from killing slow SSE streams during LM Studio prefill
  error(err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 })
  },
  async fetch(req, server) {
    try {
    const url = new URL(req.url)

    if (url.pathname === "/ping") {
      return new Response("ok", { status: 200 })
    }

    const upstream = `${UPSTREAM}${url.pathname}${url.search}`
    const isChatCompletion = url.pathname === "/v1/chat/completions"

    // Disable idle timeout for chat completions -- LM Studio prefill can take 30s+
    if (isChatCompletion) server.timeout(req, 0)

    // One AbortController per request -- aborted when the client disconnects
    const abortCtrl = new AbortController()

    let body: any = null
    let isStreaming = false
    const log = DEBUG
      ? (msg: string) => { appendFileSync(`${LOG_DIR}/proxy.log`, `${new Date().toISOString()} ${msg}\n`) }
      : () => {}

    if (req.method === "POST" && isChatCompletion) {
      body = await req.json()
      isStreaming = body.stream === true

      const enableThinking = body?.chat_template_kwargs?.enable_thinking
      if (enableThinking === false) {
        delete body.chat_template_kwargs?.enable_thinking
        if (body.chat_template_kwargs && Object.keys(body.chat_template_kwargs).length === 0) {
          delete body.chat_template_kwargs
        }
        body.messages = [...(body.messages || []), { role: "assistant", content: "<think></think>\n" }]
        log(`enable_thinking=false: injected empty think block`)
      }
    }

    const headers: Record<string, string> = {}
    req.headers.forEach((v, k) => {
      if (k !== "host") headers[k] = v
    })

    const bodyStr = body ? JSON.stringify(body) : null
    if (isChatCompletion) {
      log(`REQ: ${req.method} ${upstream} model=${body?.model || "?"} stream=${isStreaming} bodyLen=${bodyStr?.length || 0} messages=${body?.messages?.length || 0}`)
    }

    const upstreamRes = await fetch(upstream, {
      method: req.method,
      headers,
      body: bodyStr || req.body,
      signal: abortCtrl.signal,
    })

    log(`RES: ${upstreamRes.status} ${upstreamRes.statusText} content-type=${upstreamRes.headers.get("content-type")}`)

    // If upstream returned an error, log the body and pass it through
    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text()
      log(`RES BODY (error): ${errBody.slice(0, 2000)}`)
      return new Response(errBody, {
        status: upstreamRes.status,
        headers: Object.fromEntries(upstreamRes.headers.entries()),
      })
    }

    const needsProxy = isChatCompletion && (body?.model?.includes("qwen3.5") || body?.model?.includes("qwen3.6"))
    const MAX_RETRIES = 3

    if (!needsProxy) {
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: Object.fromEntries(upstreamRes.headers.entries()),
      })
    }

    if (!isStreaming) {
      let data = await upstreamRes.json() as any
      let retries = 0

      while (retries <= MAX_RETRIES) {
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
          }
        }

        const choice = data.choices?.[0]
        const msg = choice?.message
        const reasoningOnly = msg?.reasoning_content?.trim()
          && (!msg?.content || !msg.content.trim())
          && (!msg?.tool_calls || msg.tool_calls.length === 0)
          && choice?.finish_reason === "stop"

        if (!reasoningOnly || retries >= MAX_RETRIES) {
          if (reasoningOnly) {
            log(`reasoning-only response after ${MAX_RETRIES} retries, emitting as content`)
            msg.content = msg.reasoning_content
            msg.reasoning_content = ""
          }
          break
        }

        retries++
        log(`reasoning-only response detected (non-streaming), retrying (${retries}/${MAX_RETRIES})`)

        body.messages.push({
          role: "user",
          content: `Your response was incomplete. Here is your thinking so far:\n\n<think>\n${msg.reasoning_content.trim()}\n</think>\n\nDo not repeat your thinking. Please continue with your response.`,
        })

        const retryRes = await fetch(upstream, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortCtrl.signal,
        })

        if (!retryRes.ok) {
          log(`retry failed: ${retryRes.status} ${retryRes.statusText}`)
          msg.content = msg.reasoning_content
          msg.reasoning_content = ""
          break
        }

        data = await retryRes.json() as any
      }

      return Response.json(data, {
        status: upstreamRes.status,
        headers: Object.fromEntries(upstreamRes.headers.entries()),
      })
    }

    // Streaming
    if (!upstreamRes.body) {
      log(`WARN: upstream returned no body for streaming request`)
      return new Response("", { status: 200 })
    }
    let reader = upstreamRes.body.getReader()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    let reasoningBuffer = ""
    // How much of reasoningBuffer has already been forwarded to the client as
    // reasoning_content. The portion from this index to the end is held back
    // pending tool-call detection.
    let forwardedReasoningLen = 0
    let toolCallDetected = false
    let templateChunk: any = null
    let lineBuffer = ""
    let hasContent = false
    let retries = 0
    let lastReasoningChar = ""
    let streamClosed = false
    let finishedEmitted = false

    function closeStream(ctrl: ReadableStreamDefaultController) {
      if (streamClosed) return
      streamClosed = true
      try { ctrl.close() } catch {}
    }

    function emit(ctrl: ReadableStreamDefaultController, raw: string) {
      if (streamClosed) return
      if (raw.trim()) log(`OUT: ${raw.trim()}`)
      ctrl.enqueue(encoder.encode(raw))
    }

    function emitChunk(ctrl: ReadableStreamDefaultController, data: any) {
      emit(ctrl, "data: " + JSON.stringify(data) + "\n\n")
    }

    function getBase() {
      return templateChunk || {
        id: "proxy",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "proxy",
      }
    }

    function resetForRetry() {
      reasoningBuffer = ""
      forwardedReasoningLen = 0
      toolCallDetected = false
      lineBuffer = ""
      hasContent = false
      finishedEmitted = false
    }

    // Find all complete <tool_call>...</tool_call> ranges at the top level
    // (i.e. not nested inside a parameter value). Uses the tokenizer so it
    // honours the same nesting rules as parseToolCalls.
    function findToolCallRanges(buf: string): Array<{ start: number; end: number }> {
      const { tokens } = tokenize(buf)
      const ranges: Array<{ start: number; end: number }> = []
      let openAt: number | null = null
      for (const t of tokens) {
        if (t.kind === "openToolCall") openAt = t.start
        else if (t.kind === "closeToolCall" && openAt !== null) {
          ranges.push({ start: openAt, end: t.end })
          openAt = null
        }
      }
      return ranges
    }

    // Returns the position in `buf` up to which we can safely release content
    // as reasoning. Anything from this position onwards is part of a possible
    // trailing tool-call run (or a partial tag) and must keep being held back
    // until the stream ends or we learn it isn't trailing.
    //
    // The candidate trailing region must look like:
    //   (whitespace? closed-tool-call)+ whitespace? (open-tool-call partial?)?
    // ending at the tokenizer's `consumedUpTo` boundary (anything past that is
    // still ambiguous and held implicitly).
    function safeReleaseEnd(buf: string): number {
      const { tokens, consumedUpTo } = tokenize(buf)

      // Collect closed tool-call ranges and the position of any unclosed
      // <tool_call> opener at the tail (depth at most 1 in practice).
      const closed: Array<{ start: number; end: number }> = []
      let openTail: number | null = null
      for (const t of tokens) {
        if (t.kind === "openToolCall") openTail = t.start
        else if (t.kind === "closeToolCall" && openTail !== null) {
          closed.push({ start: openTail, end: t.end })
          openTail = null
        }
      }

      // If there's nothing tool-call-shaped at all, the safe boundary is just
      // wherever the tokenizer is sure of (held tail handles partial tags).
      if (closed.length === 0 && openTail === null) return consumedUpTo

      // The tentative anchor of the trailing region: the unclosed opener if
      // there is one, otherwise the latest closed range.
      const anchorEnd = openTail !== null ? buf.length : closed[closed.length - 1].end
      const anchorStart = openTail !== null ? openTail : closed[closed.length - 1].start

      // For the latest closed range (or the open tail) to be part of the
      // trailing run, everything between its end and consumedUpTo must be
      // whitespace. If there's any non-whitespace after a closed range, the
      // model continued reasoning and that range is mid-reasoning -- release
      // it.
      if (openTail === null && buf.slice(anchorEnd, consumedUpTo).trim() !== "") {
        return consumedUpTo
      }

      // Walk leftwards through earlier closed ranges. Each is part of the run
      // only if separated from the next by whitespace alone.
      let runStart = anchorStart
      const startFrom = openTail !== null ? closed.length - 1 : closed.length - 2
      for (let i = startFrom; i >= 0; i--) {
        const here = closed[i]
        const between = buf.slice(here.end, runStart)
        if (between.trim() !== "") break
        runStart = here.start
      }

      return runStart
    }

    function flushBufferedToolCalls(ctrl: ReadableStreamDefaultController) {
      if (finishedEmitted || !toolCallDetected) return

      const held = reasoningBuffer.slice(forwardedReasoningLen)
      const splitAt = (() => {
        // At stream end, the "candidate trailing region" is final -- parse it.
        const ranges = findToolCallRanges(held)
        if (ranges.length === 0) return held.length
        const last = ranges[ranges.length - 1]
        if (held.slice(last.end).trim() !== "") return held.length
        let start = last.start
        for (let i = ranges.length - 2; i >= 0; i--) {
          if (held.slice(ranges[i].end, ranges[i + 1].start).trim() !== "") break
          start = ranges[i].start
        }
        return start
      })()

      const reasoning = held.slice(0, splitAt).trimEnd()
      const toolCallRegion = held.slice(splitAt)
      const toolCalls = toolCallRegion ? parseToolCalls(toolCallRegion) : []

      log(`flushBufferedToolCalls: parsed=${toolCalls.length} reasoningLen=${reasoning.length} regionLen=${toolCallRegion.length}`)

      if (reasoning) {
        emitChunk(ctrl, {
          ...getBase(),
          choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
        })
      }

      if (toolCalls.length === 0) return

      toolCalls.forEach((tc, i) => {
        emitChunk(ctrl, {
          ...getBase(),
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
        })
      })

      emitChunk(ctrl, {
        ...getBase(),
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      })
      finishedEmitted = true
    }

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          while (!streamClosed) {
            const { done, value } = await reader.read()
            if (done || streamClosed) {
              log(`stream done: toolCallDetected=${toolCallDetected} bufLen=${reasoningBuffer.length}`)
              flushBufferedToolCalls(controller)
              closeStream(controller)
              return
            }

            const text = lineBuffer + decoder.decode(value, { stream: true })
            const lines = text.split("\n")
            lineBuffer = lines.pop() || ""

            for (const line of lines) {
              if (!line.startsWith("data: ")) {
                emit(controller, (line.trim() ? line : "") + "\n")
                continue
              }

              log(`IN: ${line}`)

              if (line === "data: [DONE]") {
                flushBufferedToolCalls(controller)
                emit(controller, line + "\n")
                closeStream(controller)
                return
              }

              let chunk: any
              try {
                chunk = JSON.parse(line.slice(6))
              } catch {
                emit(controller, line + "\n")
                continue
              }

              if (!templateChunk) templateChunk = JSON.parse(JSON.stringify(chunk))

              const delta = chunk.choices?.[0]?.delta
              const finishReason = chunk.choices?.[0]?.finish_reason

              // Reasoning content: accumulate into the buffer. On every
              // chunk, ask the tokenizer how much of the buffer is safe to
              // release as reasoning -- that is, everything before a possible
              // trailing tool-call run. Mid-reasoning <tool_call> examples
              // (e.g. inside a code block) get released as soon as the model
              // continues writing non-tool-call content after them.
              if (delta?.reasoning_content !== undefined) {
                // Emit a separator between retry attempts so the merged thinking reads cleanly.
                if (retries > 0 && reasoningBuffer === "") {
                  const sep = lastReasoningChar === "\n" ? "\n" : "\n\n"
                  emitChunk(controller, {
                    ...getBase(),
                    choices: [{ index: 0, delta: { reasoning_content: sep }, finish_reason: null }],
                  })
                }

                if (delta.reasoning_content) lastReasoningChar = delta.reasoning_content.slice(-1)
                reasoningBuffer += delta.reasoning_content

                if (!toolCallDetected && reasoningBuffer.includes("<tool_call>")) {
                  toolCallDetected = true
                }

                const releaseTo = safeReleaseEnd(reasoningBuffer)
                if (releaseTo > forwardedReasoningLen) {
                  const slice = reasoningBuffer.slice(forwardedReasoningLen, releaseTo)
                  forwardedReasoningLen = releaseTo
                  emitChunk(controller, {
                    ...getBase(),
                    choices: [{ index: 0, delta: { reasoning_content: slice }, finish_reason: null }],
                  })
                }
                continue
              }

              // Content arriving means the model is done thinking. Flush any
              // accumulated tool calls now and stop forwarding more (we've
              // taken over the finish_reason).
              if (delta?.content !== undefined) {
                if (delta.content.trim()) hasContent = true
                if (toolCallDetected) {
                  flushBufferedToolCalls(controller)
                  closeStream(controller)
                  return
                }
                emit(controller, line + "\n")
                continue
              }

              if (finishReason) {
                if (toolCallDetected) {
                  flushBufferedToolCalls(controller)
                  closeStream(controller)
                  return
                }

                // Reasoning-only response retry: model produced thinking but no
                // content or tool calls. Nudge it to continue.
                if (!hasContent && reasoningBuffer.trim() && finishReason === "stop") {
                  if (retries < MAX_RETRIES) {
                    retries++
                    log(`reasoning-only response detected, retrying (${retries}/${MAX_RETRIES})`)

                    body.messages.push({
                      role: "user",
                      content: `Your response was incomplete. Here is your thinking so far:\n\n<think>\n${reasoningBuffer.trim()}\n</think>\n\nDo not repeat your thinking. Please continue with your response.`,
                    })

                    const retryRes = await fetch(upstream, {
                      method: "POST",
                      headers,
                      body: JSON.stringify(body),
                      signal: abortCtrl.signal,
                    })

                    if (retryRes.ok && retryRes.body) {
                      reader.cancel().catch(() => {})
                      reader = retryRes.body.getReader()
                      resetForRetry()
                      break
                    }

                    log(`retry failed: ${retryRes.status} ${retryRes.statusText}`)
                    // Fall through and emit the original finish chunk.
                  } else {
                    log(`reasoning-only response after ${MAX_RETRIES} retries, emitting as content`)
                    emitChunk(controller, {
                      ...getBase(),
                      choices: [{
                        index: 0,
                        delta: { content: reasoningBuffer.trim() },
                        finish_reason: null,
                      }],
                    })
                  }
                }
              }

              emit(controller, line + "\n")
            }
          }
        } catch (err: any) {
          if (err?.name === "AbortError" || abortCtrl.signal.aborted) {
            log(`stream aborted by client`)
            closeStream(controller)
          } else if (!streamClosed) {
            log(`stream error: ${err?.stack || err?.message || "unknown"}`)
            try { controller.error(err) } catch {}
          }
          reader.cancel().catch(() => {})
        }
      },
      cancel(reason) {
        log(`stream CANCELLED by client: ${reason || "no reason"}`)
        streamClosed = true
        abortCtrl.abort()
        reader.cancel().catch(() => {})
      },
    })

    const respHeaders = Object.fromEntries(upstreamRes.headers.entries())
    delete respHeaders["content-length"]
    delete respHeaders["transfer-encoding"]
    return new Response(stream, {
      status: upstreamRes.status,
      headers: respHeaders,
    })
    } catch (err: any) {
      log(`error: ${err?.stack || err?.message || "unknown"}`)
      return new Response(`Proxy error: ${err?.message || "unknown"}`, { status: 502 })
    }
  },
})


