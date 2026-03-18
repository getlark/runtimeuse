#!/usr/bin/env node

import { execSync } from "child_process";
import path from "path";
import { RuntimeUseServer } from "./server.js";
import { openaiHandler } from "./openai-handler.js";
import { claudeHandler } from "./claude-handler.js";
import type { AgentHandler } from "./agent-handler.js";

const BUILTIN_AGENTS = ["openai", "claude"] as const;
type BuiltinAgent = (typeof BUILTIN_AGENTS)[number];

function usage(): never {
  console.log(`Usage: runtimeuse [options]

Options:
  --handler <path>           Path to a custom JS/TS module exporting an AgentHandler
  --agent <openai|claude>    Built-in agent SDK to use (default: openai)
  --port <number>            WebSocket server port (default: 8080)
  -h, --help                 Show this help message`);
  process.exit(0);
}

export function parseArgs(
  args: string[],
  onHelp: () => never = usage,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      onHelp();
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        result[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (i + 1 < args.length) {
        result[arg.slice(2)] = args[++i];
      }
    }
  }
  return result;
}

function checkClaudeCli(): void {
  try {
    execSync("claude --version", { stdio: "ignore" });
  } catch {
    console.error(
      "Error: the Claude handler requires the Claude CLI (`claude`) to be installed.\n" +
        "Install it with: npm install -g @anthropic-ai/claude-code\n" +
        "Or use the OpenAI handler with --agent openai (default)",
    );
    process.exit(1);
  }
}

function getBuiltinHandler(agent: BuiltinAgent): AgentHandler {
  if (agent === "claude") {
    checkClaudeCli();
    return claudeHandler;
  }
  return openaiHandler;
}

async function loadHandler(handlerPath: string): Promise<AgentHandler> {
  const resolved = path.resolve(handlerPath);
  const mod = await import(resolved);
  const handler: AgentHandler | undefined = mod.default?.run
    ? mod.default
    : mod.handler;

  if (!handler?.run) {
    console.error(
      `Error: module at ${handlerPath} must export an AgentHandler (as default or named "handler")`,
    );
    process.exit(1);
  }
  return handler;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let handler: AgentHandler;
  if (args.handler) {
    handler = await loadHandler(args.handler);
  } else {
    const agent = (args.agent ?? "openai") as BuiltinAgent;
    if (!BUILTIN_AGENTS.includes(agent)) {
      console.error(
        `Error: unknown agent "${args.agent}". Choose one of: ${BUILTIN_AGENTS.join(", ")}`,
      );
      process.exit(1);
    }
    handler = getBuiltinHandler(agent);
  }

  const port = args.port ? parseInt(args.port, 10) : undefined;

  const server = new RuntimeUseServer({
    handler,
    port,
  });

  await server.startListening();
}

if (!process.env.VITEST) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
