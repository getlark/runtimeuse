import zod from "zod";

import {
  Agent,
  run as runAgent,
  codeInterpreterTool,
  webSearchTool,
  AgentOutputType,
} from "@openai/agents";
import type {
  AgentHandler,
  AgentInvocation,
  AgentResult,
  MessageSender,
} from "./agent-handler.js";

export const openaiHandler: AgentHandler = {
  async run(
    invocation: AgentInvocation,
    sender: MessageSender,
  ): Promise<AgentResult> {
    const agentConfig: ConstructorParameters<typeof Agent>[0] = {
      name: "runtimeuse-agent",
      instructions: invocation.systemPrompt,
      model: invocation.model,
      tools: [codeInterpreterTool(), webSearchTool()],
    };

    if (invocation.outputFormat) {
      const strictSchema = ensureStrictSchema(invocation.outputFormat.schema);
      agentConfig.outputType = zod.fromJSONSchema(strictSchema) as AgentOutputType;
    }

    const agent = new Agent(agentConfig);

    const result = await runAgent(agent, invocation.userPrompt, {
      signal: invocation.signal,
      stream: true,
    });

    let currentText = "";
    for await (const event of result) {
      if (
        event.type === "raw_model_stream_event" &&
        "delta" in event.data &&
        typeof event.data.delta === "string"
      ) {
        currentText += event.data.delta;
      } else if (
        event.type === "run_item_stream_event" &&
        event.name === "message_output_created"
      ) {
        if (currentText) {
          sender.sendAssistantMessage([currentText]);
          currentText = "";
        }
      }
    }

    await result.completed;

    if (currentText) {
      sender.sendAssistantMessage([currentText]);
    }

    const metadata: Record<string, unknown> = {};
    const usage = result.state?.usage;
    if (usage) {
      metadata.usage = {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      };
    }

    const finalOutput = result.finalOutput;

    if (!invocation.outputFormat) {
      if (typeof finalOutput !== "string") {
        throw new Error(
          `Expected string result but got ${typeof finalOutput}`,
        );
      }
      return { type: "text", text: finalOutput, metadata };
    }

    let structuredOutput: Record<string, unknown>;
    if (typeof finalOutput === "string") {
      try {
        structuredOutput = JSON.parse(finalOutput);
      } catch {
        throw new Error(
          "Expected structured output but got non-JSON string",
        );
      }
    } else if (finalOutput != null && typeof finalOutput === "object") {
      structuredOutput = finalOutput as Record<string, unknown>;
    } else {
      throw new Error(
        `Expected structured output but got ${typeof finalOutput}`,
      );
    }

    return { type: "structured_output", structuredOutput, metadata };
  },
};

function ensureStrictSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...schema };
  if (result.type === "object") {
    result.additionalProperties = false;
    if (
      result.properties &&
      typeof result.properties === "object" &&
      !Array.isArray(result.properties)
    ) {
      const props: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(
        result.properties as Record<string, unknown>,
      )) {
        props[key] =
          value && typeof value === "object" && !Array.isArray(value)
            ? ensureStrictSchema(value as Record<string, unknown>)
            : value;
      }
      result.properties = props;
    }
  }
  if (result.items && typeof result.items === "object") {
    result.items = ensureStrictSchema(result.items as Record<string, unknown>);
  }
  delete result.title;
  return result;
}
