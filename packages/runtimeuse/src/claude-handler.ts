import { Options, query } from "@anthropic-ai/claude-agent-sdk";
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
    let resultText: string | undefined;
    let structuredOutput: Record<string, unknown> | undefined;
    const metadata: Record<string, unknown> = {};

    const onAbort = () => abortController.abort();
    invocation.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const queryOptions: Options = {
        systemPrompt: invocation.systemPrompt,
        model: invocation.model,
        abortController,
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: { ...process.env, ...invocation.env },
      };
      if (invocation.outputFormat) {
        queryOptions.outputFormat = invocation.outputFormat;
      }

      const conversation = query({
        prompt: invocation.userPrompt,
        options: queryOptions,
      });

      for await (const message of conversation) {
        if (message.type === "assistant") {
          const text = extractTextFromContent(message.message?.content ?? []);
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
            if (invocation.outputFormat) {
              if (message.structured_output == null) {
                throw new Error(
                  "Expected structured_output in result but got none",
                );
              }
              structuredOutput = message.structured_output as Record<
                string,
                unknown
              >;
            } else {
              if (message.structured_output != null) {
                throw new Error(
                  "Expected text result but got structured_output",
                );
              }
              resultText = message.result;
            }
          } else {
            const errorOutput = {
              error: message.subtype,
              errors: "errors" in message ? message.errors : [],
            };
            structuredOutput = errorOutput;
            sender.sendErrorMessage(
              `Agent ended with ${message.subtype}`,
              metadata,
            );
          }
        }
      }

      if (structuredOutput !== undefined) {
        return { type: "structured_output", structuredOutput, metadata };
      }
      return { type: "text", text: resultText ?? "", metadata };
    } finally {
      invocation.signal.removeEventListener("abort", onAbort);
    }
  },
};
