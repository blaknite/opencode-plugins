import type { Plugin } from "@opencode-ai/plugin"
import { spawn } from "child_process"

const PORT = 11435
const PROVIDER_ID = "lmstudio"
const SCRIPT = process.env.HOME + "/.opencode/plugins/lib/lmstudio-thinking-proxy-server.ts"
const BUN = process.env.HOME + "/.bun/bin/bun"

let upstreamURL = ""

async function isProxyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${PORT}/v1/models`, {
      signal: AbortSignal.timeout(500),
    })
    return res.ok
  } catch {
    return false
  }
}

async function ensureProxy(): Promise<boolean> {
  if (await isProxyRunning()) return true
  if (!upstreamURL) return false

  const child = spawn(BUN, ["run", SCRIPT, upstreamURL, String(PORT)], {
    detached: true,
    stdio: "ignore",
  })
  child.unref()

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await isProxyRunning()) return true
  }

  return false
}

export const LMStudioThinkingProxy: Plugin = async () => {
  return {
    config: async (cfg: any) => {
      const provider = cfg.provider?.[PROVIDER_ID]
      if (!provider?.options?.baseURL) return

      upstreamURL = provider.options.baseURL.replace(/\/v1\/?$/, "")
      const started = await ensureProxy()
      if (started) {
        provider.options.baseURL = `http://localhost:${PORT}/v1`
      }
    },

    "chat.params": async (input: any) => {
      if (input.provider?.info?.id !== PROVIDER_ID) return
      await ensureProxy()
    },
  }
}
