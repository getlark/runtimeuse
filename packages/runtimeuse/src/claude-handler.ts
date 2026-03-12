import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentHandler,
  AgentInvocation,
  AgentResult,
  MessageSender,
} from "./agent-handler.js";

function extractTextFromContent(content: unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block
    ) {
      parts.push(String(block.text));
    }
  }
  return parts.join("\n");
}

export const claudeHandler: AgentHandler = {
  async run(
    invocation: AgentInvocation,
    sender: MessageSender,
  ): Promise<AgentResult> {
    const abortController = new AbortController();

    const onAbort = () => abortController.abort();
    invocation.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const conversation = query({
        prompt: invocation.userPrompt,
        options: {
          systemPrompt: invocation.systemPrompt,
          model: invocation.model,
          outputFormat: invocation.outputFormat,
          abortController,
          cwd: process.cwd(),
          env: { ...process.env, ...invocation.env },
          tools: { type: "preset", preset: "claude_code" },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        },
      });

      let structuredOutput: Record<string, unknown> = {};
      const metadata: Record<string, unknown> = {};

      for await (const message of conversation) {
        if (message.type === "assistant") {
          const text = extractTextFromContent(
            message.message?.content ?? [],
          );
          if (text) {
            sender.sendAssistantMessage([text]);
          }
        } else if (message.type === "result") {
          metadata.duration_ms = message.duration_ms;
          metadata.duration_api_ms = message.duration_api_ms;
          metadata.num_turns = message.num_turns;
          metadata.total_cost_usd = message.total_cost_usd;
          metadata.usage = message.usage;
          metadata.session_id = message.session_id;

          if (message.subtype === "success") {
            if (message.structured_output != null) {
              structuredOutput =
                message.structured_output as Record<string, unknown>;
            } else {
              structuredOutput = { result: message.result };
            }
          } else {
            structuredOutput = {
              error: message.subtype,
              errors: "errors" in message ? message.errors : [],
            };
            sender.sendErrorMessage(
              `Agent ended with ${message.subtype}`,
              metadata,
            );
          }
        }
      }

      return { structuredOutput, metadata };
    } finally {
      invocation.signal.removeEventListener("abort", onAbort);
    }
  },
};
