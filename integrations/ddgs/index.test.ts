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

test("tries another backend when the first returns no results", async () => {
  const backends: string[] = []
  const results = [{ title: "OpenChamber", href: "https://github.com/openchamber/openchamber", body: "Source" }]
  expect(await search("OpenChamber github markdown renderer", signal, async (args) => {
    backends.push(args[args.indexOf("-b") + 1])
    expect(args[args.indexOf("-q") + 1]).toBe("OpenChamber github markdown renderer")
    if (backends.length === 1) return { stdout: "DDGSException: DDGSException('No results found.')", stderr: "" }
    await writeFile(args[args.indexOf("-o") + 1], JSON.stringify(results))
    return { stdout: "", stderr: "" }
  })).toEqual(results)
  expect(backends).toEqual(["auto", "brave"])
})

test("recovers from a transient backend failure and cleans up every attempt", async () => {
  const directories: string[] = []
  const results = [{ title: "Documentation", href: "https://opencode.ai/v2/docs/", body: "Docs" }]
  expect(await search("documentation", signal, async (args) => {
    const path = args[args.indexOf("-o") + 1]
    directories.push(dirname(path))
    if (directories.length === 1) throw new Error("backend timed out")
    await writeFile(path, JSON.stringify(results))
    return { stdout: "", stderr: "" }
  })).toEqual(results)
  for (const directory of directories) await expect(access(directory)).rejects.toThrow()
})

test("filters excluded domains and unsafe URLs without reducing the query", async () => {
  const results = [
    { title: "Excluded", href: "https://old.reddit.com/post", body: "Post" },
    { title: "Unsafe", href: "javascript:alert(1)", body: "Unsafe" },
    { title: "Invalid", href: "not a URL", body: "Invalid" },
    ...Array.from({ length: 4 }, (_, index) => ({ title: `Result ${index}`, href: `https://example.com/${index}`, body: "Result" })),
  ]
  expect(await search("documentation", signal, async (args) => {
    expect(args[args.indexOf("-q") + 1]).toBe("documentation")
    expect(args[args.indexOf("-m") + 1]).toBe("10")
    await writeFile(args[args.indexOf("-o") + 1], JSON.stringify(results))
    return { stdout: "", stderr: "" }
  })).toEqual(results.slice(3, 6))
})

test("bounds empty-result fallback attempts", async () => {
  const backends: string[] = []
  expect(await search("no matches", signal, async (args) => {
    backends.push(args[args.indexOf("-b") + 1])
    await writeFile(args[args.indexOf("-o") + 1], "[]")
    return { stdout: "", stderr: "" }
  })).toEqual([])
  expect(backends).toEqual(["auto", "brave", "yahoo"])
})

test("does not retry when the ddgs executable is missing", async () => {
  let attempts = 0
  await expect(search("documentation", signal, async () => {
    attempts += 1
    throw Object.assign(new Error("spawn ddgs ENOENT"), { code: "ENOENT" })
  })).rejects.toThrow("spawn ddgs ENOENT")
  expect(attempts).toBe(1)
})
