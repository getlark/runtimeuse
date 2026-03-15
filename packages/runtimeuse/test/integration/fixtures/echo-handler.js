/**
 * Deterministic echo handler for integration tests.
 *
 * Interprets special prefixes in the user prompt to control behavior:
 *   ECHO:<text>           — return text result
 *   STRUCTURED:<json>     — return structured_output result
 *   SLOW:<ms>             — sleep then return text (timeout / cancel tests)
 *   STREAM:<n>            — send n assistant messages before returning
 *   ERROR:<msg>           — send error via sender and throw
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

    if (prompt.startsWith("ERROR:")) {
      const msg = prompt.slice("ERROR:".length);
      sender.sendErrorMessage(msg, { source: "echo_handler" });
      throw new Error(msg);
    }

    return { type: "text", text: prompt };
  },
};
