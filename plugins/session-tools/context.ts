import type { Plugin } from "@opencode/plugin";

const DEFAULT_CONTEXT_TOKENS = 128000;

export async function modelContextTokens(
  ctx: Plugin.Context,
  model: { providerID: string; id: string },
): Promise<number> {
  try {
    const models = await ctx.model.list();
    const found = models.data.find(
      (candidate) =>
        candidate.providerID === model.providerID && candidate.id === model.id,
    );
    const context = found?.limit.context;
    if (typeof context === "number" && context > 0) return context;
  } catch {}
  return DEFAULT_CONTEXT_TOKENS;
}
