import type { Plugin } from "@opencode-ai/plugin";
import type { Todo } from "@opencode-ai/sdk";

const ALLOWED_AGENTS = new Set(["local", "local (plan)"]);

export const TodoReminder: Plugin = async () => {
  let todos: Todo[] = [];
  const sessionAgent = new Map<string, string>();

  return {
    event: async ({ event }) => {
      if (event.type === "todo.updated") {
        todos = event.properties.todos;
      }
    },

    "chat.message": async (input) => {
      if (input.agent) sessionAgent.set(input.sessionID, input.agent);
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const last = output.messages[output.messages.length - 1];
      if (!last || last.info.role !== "user") return;

      const sessionID = (last.info as any).sessionID;
      const agent = sessionID ? sessionAgent.get(sessionID) : undefined;
      if (!agent || !ALLOWED_AGENTS.has(agent)) return;

      const todo =
        todos.find((t) => t.status === "in_progress") ??
        todos.find((t) => t.status === "pending");

      const message = !todo
        ? "If you have a new goal with three or more distinct steps you MUST call TodoWrite and track your process."
        : todo.status === "in_progress"
          ? `The current todo item is: "${todo.content}". Stay focused on this task. If this task is complete, mark it done and move to the next.`
          : `The next todo item is: "${todo.content}". This should be your next task.`;

      const reminder = [
        "",
        "<system-reminder>",
        message,
        "</system-reminder>",
      ].join("\n");

      last.parts.push({
        type: "text",
        synthetic: true,
        text: reminder,
      } as any);
    },
  };
};
