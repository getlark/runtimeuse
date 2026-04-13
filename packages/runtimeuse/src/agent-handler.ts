import type { Logger } from "./logger.js";

export interface AgentInvocation {
  systemPrompt: string;
  userPrompt: string;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  model: string;
  secrets: string[];
  signal: AbortSignal;
  logger: Logger;
  env?: Record<string, string>;
}

export type AgentResult =
  | { type: "text"; text: string; metadata?: Record<string, unknown> }
  | {
      type: "structured_output";
      structuredOutput: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };

export interface MessageSender {
  sendAssistantMessage(textBlocks: string[]): void;
  sendErrorMessage(error: string, metadata?: Record<string, unknown>): void;
}

export interface AgentHandler {
  run(invocation: AgentInvocation, sender: MessageSender): Promise<AgentResult>;
}
