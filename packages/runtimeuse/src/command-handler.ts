import { exec, ExecFileException } from "node:child_process";
import fs from "fs";
import type { Logger } from "./logger.js";
import type { Command } from "./types.js";
import { redactSecrets } from "./utils.js";

export interface CommandResult {
  exitCode: number;
  error?: ExecFileException;
}

export interface CommandHandlerOptions {
  command: Command;
  secrets: string[];
  logger: Logger;
  abortController: AbortController;
  onStdout?: (stdout: string) => void;
  onStderr?: (stderr: string) => void;
}
class CommandHandler {
  private readonly command: Command;
  private readonly secrets: string[];
  private readonly logger: Logger;
  private readonly onStdout?: (stdout: string) => void;
  private readonly onStderr?: (stderr: string) => void;
  private readonly abortController: AbortController;
  constructor(options: CommandHandlerOptions) {
    this.command = options.command;
    this.secrets = options.secrets;
    this.logger = options.logger;
    this.abortController = options.abortController;
    this.onStdout = options.onStdout;
    this.onStderr = options.onStderr;
  }

  private redactSecrets(data: string): string {
    return redactSecrets(data, this.secrets);
  }

  async execute(): Promise<CommandResult> {
    if (this.command.cwd) {
      if (!fs.existsSync(this.command.cwd)) {
        fs.mkdirSync(this.command.cwd, { recursive: true });
      }
    }
    return new Promise((resolve, reject) => {
      const result = exec(
        this.command.command,
        {
          cwd: this.command.cwd ?? process.cwd(),
          env: { ...process.env, ...this.command.env },
          signal: this.abortController.signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            const code =
              typeof error.code === "number" ? error.code : -1;
            return resolve({ exitCode: code, error });
          }
        },
      );

      result.stdout?.on("data", (data) => {
        const redactedData = this.redactSecrets(data);
        this.onStdout?.(redactedData);
      });
      result.stderr?.on("data", (data) => {
        const redactedData = this.redactSecrets(data);
        this.onStderr?.(redactedData);
      });
      result.on("exit", (code) => {
        this.logger.log("Command exited with code:", code);
      });
      result.on("error", (error) => {
        this.logger.error("Command error:", error);
        return reject({ exitCode: 2, error });
      });
      result.on("spawn", () => {
        this.logger.log("Command spawned:", this.command.command);
      });

      result.on("close", (code) => {
        this.logger.log("Command closed with code:", code);
        return resolve({ exitCode: code ?? 0 });
      });
    });
  }
}

export default CommandHandler;
