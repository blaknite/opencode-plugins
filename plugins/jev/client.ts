import { z } from "zod";

const description = z.string().min(1);
const question = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: description,
    criteria: z.object({ true: description.optional(), false: description.optional() }).strict().optional(),
  }).strict(),
  z.object({
    type: z.literal("choice"),
    instructions: description,
    criteria: z.record(z.string().min(1), z.string().nullable()).refine(
      (options) => Object.keys(options).length >= 1 && Object.keys(options).length <= 255,
      "Choice requires 1–255 options",
    ),
  }).strict(),
  z.object({
    type: z.literal("score"),
    instructions: description,
    criteria: z.array(description).min(2).max(10),
  }).strict(),
]);

export const evaluationInput = z.object({
  state: z.string().min(1).max(100_000).describe("Relevant, sanitized context. Sent to TypeSafe's hosted API; never include secrets or sensitive company/customer data."),
  questions: z.record(z.string().min(1), question).refine(
    (questions) => Object.keys(questions).length >= 1 && Object.keys(questions).length <= 20,
    "Provide 1–20 independent, narrowly scoped questions",
  ),
}).strict();

const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);
const answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), noul: probability }),
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities, confidence: probability }),
  z.object({ type: z.literal("score"), score: z.number(), legend: z.record(z.string(), z.string()), probabilities, confidence: probability }),
]);
const evaluationResponse = z.object({
  model: z.string(),
  answers: z.record(z.string(), answer),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

export async function evaluate(
  input: unknown,
  options: { apiKey?: string; signal: AbortSignal; fetch?: typeof fetch },
) {
  const request = evaluationInput.parse(input);
  const apiKey = options.apiKey?.trim();
  if (!apiKey) {
    throw new Error("Jev is not connected. Save your key in the private OpenCode credentials/jev-api-key file (permissions 600), or set TYPESAFE_API_KEY in the service environment. See plugins/jev/README.md for setup. Create a key at https://console.typesafe.ai/keys; never paste it into chat.");
  }

  const response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...request, model: "jev-latest" }),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
    redirect: "error",
  });

  if (!response.ok) {
    const guidance = response.status === 401
      ? "Check TYPESAFE_API_KEY."
      : response.status === 429 || response.status === 529
        ? "Wait before retrying; do not retry in a tight loop."
        : "Check the request and TypeSafe service status.";
    throw new Error(`Jev API returned HTTP ${response.status}. ${guidance}`);
  }

  const parsed = evaluationResponse.safeParse(await response.json());
  if (!parsed.success) throw new Error("Jev API returned an invalid response; do not use it to make a decision.");
  const result = parsed.data;
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = result.answers[id];
    if (!answer || answer.type !== question.type) {
      throw new Error("Jev API returned missing or mismatched answers; do not use them to make a decision.");
    }
    if (question.type === "choice" && answer.type === "choice" && !Object.hasOwn(question.criteria, answer.choice)) {
      throw new Error("Jev API selected an unknown choice; do not use it to make a decision.");
    }
  }
  return result;
}
