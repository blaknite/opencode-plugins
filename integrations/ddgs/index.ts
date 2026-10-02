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

function run(args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const process = spawn("ddgs", args, { signal, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    let error = ""
    process.stdout.setEncoding("utf8")
    process.stderr.setEncoding("utf8")
    process.stdout.on("data", (chunk) => { output += chunk })
    process.stderr.on("data", (chunk) => { error += chunk })
    process.on("error", reject)
    process.on("close", (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`ddgs exited with code ${code}: ${error.trim()}`))
    })
  })
}

async function search(query: string, signal: AbortSignal): Promise<Result[]> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-ddgs-"))
  try {
    const path = join(directory, "results.json")
    const exclusions = [...excluded].map((site) => `-site:${site}`).join(" ")
    await run(["text", "-q", `${query} ${exclusions}`, "-m", "3", "-b", "auto", "-o", path], signal)
    return JSON.parse(await readFile(path, "utf8")) as Result[]
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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
          return Promise.all(results.filter((result) => {
            try {
              return ![...excluded].some((site) => {
                const hostname = new URL(result.href).hostname
                return hostname === site || hostname.endsWith(`.${site}`)
              })
            } catch {
              return false
            }
          }).map(async (result) => {
            let content = result.body
            try {
              const extracted = await run(["extract", "-u", result.href, "-f", "text_markdown"], signal)
              content = extracted.replace(/^URL:\s.*\n\n/, "").trim() || content
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
