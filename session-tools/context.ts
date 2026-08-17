import type { PluginInput } from "@opencode-ai/plugin"

const DEFAULT_CONTEXT_TOKENS = 128000

export async function modelContextTokens(
  input: PluginInput,
  model: { providerID: string; modelID: string },
): Promise<number> {
  try {
    const result = await input.client.config.providers()
    const providers = result.data?.providers ?? []
    for (const provider of providers) {
      if (provider.id !== model.providerID) continue
      const found = provider.models?.[model.modelID]
      const context = found?.limit?.context
      if (typeof context === "number" && context > 0) return context
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_CONTEXT_TOKENS
}
