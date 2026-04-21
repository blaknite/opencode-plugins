import type { Plugin } from "@opencode-ai/plugin";

const REMINDER = [
  "",
  "<system-reminder>",
  "If this is a new task, you MUST call find_skill before responding.",
  "</system-reminder>",
].join("\n");

export const SkillReminder: Plugin = async () => {
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      const last = output.messages[output.messages.length - 1];
      if (last && last.info.role === "user") {
        last.parts.push({
          type: "text",
          synthetic: true,
          text: REMINDER,
        } as any);
      }
    },
  };
};
