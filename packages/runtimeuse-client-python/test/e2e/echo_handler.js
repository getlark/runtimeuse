/**
 * Deterministic echo handler for e2e tests.
 *
 * Interprets special prefixes in the user prompt to control behavior:
 *   ECHO:<text>           — return text result
 *   STRUCTURED:<json>     — return structured_output result
 *   SLOW:<ms>             — sleep then return text (timeout / cancel tests)
 *   STREAM:<n>            — send n assistant messages before returning
 *   STREAM_TEXT:<text>    — send text as assistant message, then return "done"
 *   ERROR:<msg>           — send error via sender and throw
 *   WRITE_FILE:<path> <c> — write file, sleep 3s for chokidar, return text
 *   READ_FILE:<path>      — read file and return its contents as text
 *   (anything else)       — echo the prompt back as text
 */

export const handler = {
  async run(invocation, sender) {
    const prompt = invocation.userPrompt;

    if (prompt.startsWith("ECHO:")) {
      return { type: "text", text: prompt.slice("ECHO:".length) };
    }

    if (prompt.startsWith("STRUCTURED:")) {
      const json = prompt.slice("STRUCTURED:".length);
      return {
        type: "structured_output",
        structuredOutput: JSON.parse(json),
      };
    }

    if (prompt.startsWith("SLOW:")) {
      const ms = parseInt(prompt.slice("SLOW:".length), 10);
      await new Promise((r) => setTimeout(r, ms));
      return { type: "text", text: "done" };
    }

    if (prompt.startsWith("STREAM:")) {
      const count = parseInt(prompt.slice("STREAM:".length), 10);
      for (let i = 0; i < count; i++) {
        sender.sendAssistantMessage([`message ${i + 1} of ${count}`]);
      }
      return { type: "text", text: `streamed ${count} messages` };
    }

    if (prompt.startsWith("STREAM_TEXT:")) {
      const text = prompt.slice("STREAM_TEXT:".length);
      sender.sendAssistantMessage([text]);
      return { type: "text", text: "done" };
    }

    if (prompt.startsWith("WRITE_FILE:")) {
      const rest = prompt.slice("WRITE_FILE:".length);
      const spaceIdx = rest.indexOf(" ");
      const filePath = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const content = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
      const fs = await import("fs");
      const path = await import("path");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      await new Promise((r) => setTimeout(r, 3000));
      return { type: "text", text: `wrote ${filePath}` };
    }

    if (prompt.startsWith("READ_FILE:")) {
      const filePath = prompt.slice("READ_FILE:".length).trim();
      const fs = await import("fs");
      const content = fs.readFileSync(filePath, "utf-8");
      return { type: "text", text: content };
    }

    if (prompt.startsWith("ERROR:")) {
      const msg = prompt.slice("ERROR:".length);
      sender.sendErrorMessage(msg, { source: "echo_handler" });
      throw new Error(msg);
    }

    return { type: "text", text: prompt };
  },
};
