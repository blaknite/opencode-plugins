import { expect, test } from "bun:test"
import { access, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { search } from "./index"

const signal = new AbortController().signal

test("reads search results and removes temporary files", async () => {
  const results = [{ title: "Documentation", href: "https://opencode.ai/v2/docs/", body: "Docs" }]
  let directory = ""
  expect(await search("documentation", signal, async (args) => {
    const path = args[args.indexOf("-o") + 1]
    directory = dirname(path)
    await writeFile(path, JSON.stringify(results))
    return { stdout: "", stderr: "" }
  })).toEqual(results)
  await expect(access(directory)).rejects.toThrow()
})

test("returns empty results for ddgs's zero-exit no-results exception", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    expect(await search("no matches", signal, async () => ({
      stdout: "",
      stderr: "",
      [stream]: "DDGSException: DDGSException('No results found.')\n",
    }))).toEqual([])
  }
})

test("preserves backend diagnostics when no results file is written", async () => {
  await expect(search("documentation", signal, async () => ({
    stdout: "DDGSException: Ratelimit",
    stderr: "backend unavailable",
  }))).rejects.toThrow("ddgs did not produce search results: backend unavailable\nDDGSException: Ratelimit")
})

test("reports missing output even when ddgs prints nothing", async () => {
  await expect(search("documentation", signal, async () => ({ stdout: "", stderr: "" })))
    .rejects.toThrow("ddgs did not produce search results: no output from ddgs")
})

test("does not hide other failures behind a no-results message", async () => {
  await expect(search("documentation", signal, async () => ({
    stdout: "DDGSException: DDGSException('No results found.')",
    stderr: "connection failed",
  }))).rejects.toThrow("connection failed")
})

test("propagates process failures", async () => {
  await expect(search("documentation", signal, async () => {
    throw new Error("ddgs exited with code 1: backend failed")
  })).rejects.toThrow("ddgs exited with code 1: backend failed")
})

test("does not turn cancellation into empty results", async () => {
  const controller = new AbortController()
  await expect(search("documentation", controller.signal, async () => {
    controller.abort()
    return { stdout: "DDGSException: DDGSException('No results found.')", stderr: "" }
  })).rejects.toThrow()
})
