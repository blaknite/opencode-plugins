import type { Plugin } from "@opencode-ai/plugin";
import type { Todo } from "@opencode-ai/sdk";

export const TodoReminder: Plugin = async () => {
  let todos: Todo[] = [];

  return {
    event: async ({ event }) => {
      if (event.type === "todo.updated") {
        todos = event.properties.todos;
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const todo =
        todos.find((t) => t.status === "in_progress") ??
        todos.find((t) => t.status === "pending");

      if (!todo) {
        const reminder = [
          "",
          "<system-reminder>",
          "If this is a multi-step task, use TodoWrite to break it down before starting.",
          "</system-reminder>",
        ].join("\n");

        const last = output.messages[output.messages.length - 1];
        if (last && last.info.role === "user") {
          last.parts.push({
            type: "text",
            synthetic: true,
            text: reminder,
          } as any);
        }
        return;
      }

      const message =
        todo.status === "in_progress"
          ? `The current todo item is: "${todo.content}". Stay focused on this task. If this task is complete, mark it done and move to the next.`
          : `The next todo item is: "${todo.content}". This should be your next task.`;

      const reminder = [
        "",
        "<system-reminder>",
        message,
        "</system-reminder>",
      ].join("\n");

      const last = output.messages[output.messages.length - 1];
      if (last && last.info.role === "user") {
        last.parts.push({
          type: "text",
          synthetic: true,
          text: reminder,
        } as any);
      }
    },
  };
};
