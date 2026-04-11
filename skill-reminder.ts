import type { Plugin } from "@opencode-ai/plugin"
import { randomBytes } from "crypto"

function partID(): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let result = ""
  const bytes = randomBytes(26)
  for (let i = 0; i < 26; i++) {
    result += chars[bytes[i] % 62]
  }
  return "prt_" + result
}

export const SkillReminder: Plugin = async () => {
  return {
    "chat.message": async (input, output) => {
      output.parts.push({
        id: partID(),
        sessionID: input.sessionID,
        messageID: output.message.id,
        type: "text",
        synthetic: true,
        text: [
          "<system-reminder>",
          "Check if there are relevant skills for this task by calling the find_skill tool before proceeding.",
          "</system-reminder>",
        ].join("\n"),
      } as any)
    },
  }
}
