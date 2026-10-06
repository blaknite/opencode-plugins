import type { Plugin } from "@opencode/plugin/promise/plugin"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface Result {
  title: string
  href: string
  body: string
}

const excluded = new Set([
  "reddit.com",
  "quora.com",
  "pinterest.com",
  "instagram.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "linkedin.com",
])

function run(args: string[], signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn("ddgs", args, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let error = ""
    process.stdout.setEncoding("utf8")
    process.stderr.setEncoding("utf8")
    process.stdout.on("data", (chunk) => { output += chunk })
    process.stderr.on("data", (chunk) => { error += chunk })
    process.on("error", reject)
    process.on("close", (code) => {
      if (code === 0) resolve({ stdout: output, stderr: error })
      else reject(new Error(`ddgs exited with code ${code}: ${[error, output].filter(Boolean).join("\n").trim()}`))
    })
  })
}

function allowed(result: Result): boolean {
  try {
    const url = new URL(result.href)
    return ["http:", "https:"].includes(url.protocol) && ![...excluded].some((site) => {
      return url.hostname === site || url.hostname.endsWith(`.${site}`)
    })
  } catch {
    return false
  }
}

async function attempt(query: string, backend: string, signal: AbortSignal, execute: typeof run): Promise<Result[]> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-ddgs-"))
  try {
    const path = join(directory, "results.json")
    const output = await execute(["text", "-q", query, "-m", "10", "-b", backend, "-o", path], signal)
    signal.throwIfAborted()
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      const diagnostic = [output.stderr, output.stdout].filter(Boolean).join("\n").trim()
      if (/^DDGSException: DDGSException\(['"]No results found\.['"]\)\s*$/.test(diagnostic)) return []
      throw new Error(`ddgs did not produce search results: ${diagnostic || "no output from ddgs"}`, { cause: error })
    }
    return (JSON.parse(content) as Result[]).filter(allowed).slice(0, 3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function search(query: string, signal: AbortSignal, execute = run): Promise<Result[]> {
  const errors: Error[] = []
  for (const backend of ["auto", "brave", "yahoo"]) {
    signal.throwIfAborted()
    try {
      const results = await attempt(query, backend, signal, execute)
      if (results.length) return results
    } catch (error) {
      signal.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error
      errors.push(new Error(`${backend}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }))
    }
  }
  if (errors.length) throw new AggregateError(errors, `DDGS search failed: ${errors.map((error) => error.message).join("; ")}`)
  return []
}

export default {
  id: "ddgs-websearch",
  async setup(ctx) {
    await ctx.websearch.transform((editor) => {
      editor.add({
        id: "ddgs",
        name: "Local ddgs",
        async execute({ query }, { signal }) {
          const results = await search(query, signal)
          return Promise.all(results.map(async (result) => {
            let content = result.body
            try {
              const extracted = await run(["extract", "-u", result.href, "-f", "text_markdown"], signal)
              content = extracted.stdout.replace(/^URL:\s.*\n\n/, "").trim() || content
            } catch (error) {
              if (signal.aborted) throw error
            }
            return { url: result.href, title: result.title, content: content.slice(0, 10000), time: {} }
          }))
        },
      })
      editor.default.set("ddgs")
    })
  },
} satisfies Plugin
