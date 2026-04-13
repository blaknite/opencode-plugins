import type { Plugin } from "@opencode-ai/plugin";

const REMINDER = [
  "",
  "<system-reminder>",
  "If the user is asking you to do something new, you MUST call find_skill before responding.",
  "</system-reminder>",
].join("\n");

export const SkillReminder: Plugin = async () => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      // Find the last user message and append the reminder to its parts
      for (let i = output.messages.length - 1; i >= 0; i--) {
        const { info, parts } = output.messages[i];
        if (info.role === "user") {
          parts.push({
            type: "text",
            synthetic: true,
            text: REMINDER,
          } as any);
          break;
        }
      }
    },
  };
};
