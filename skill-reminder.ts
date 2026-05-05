import type { Plugin } from "@opencode-ai/plugin";

const REMINDER = [
  "",
  "<system-reminder>",
  "If you have a new goal you MUST call find_skill.",
  "</system-reminder>",
].join("\n");

const ALLOWED_AGENTS = new Set(["local", "local (plan)"]);

export const SkillReminder: Plugin = async () => {
  const sessionAgent = new Map<string, string>();

  return {
    "chat.message": async (input) => {
      if (input.agent) sessionAgent.set(input.sessionID, input.agent);
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const last = output.messages[output.messages.length - 1];
      if (!last || last.info.role !== "user") return;

      const sessionID = (last.info as any).sessionID;
      const agent = sessionID ? sessionAgent.get(sessionID) : undefined;
      if (!agent || !ALLOWED_AGENTS.has(agent)) return;

      last.parts.push({
        type: "text",
        synthetic: true,
        text: REMINDER,
      } as any);
    },
  };
};
