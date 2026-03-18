import { AsyncQueue } from "./async-queue.js";
import { AgentRuntimeError, CancelledException } from "./errors.js";
import type { Transport } from "./transports/transport.js";
import { WebSocketTransport } from "./transports/websocket-transport.js";
import {
  defaultLogger,
  isValidAgentRuntimeMessage,
  type ArtifactUploadResponseMessage,
  type CancelMessage,
  type ErrorMessage,
  type InvocationMessage,
  type Logger,
  type QueryOptions,
  type QueryResult,
  type ResultMessage,
} from "./types.js";

/**
 * Client for communicating with a runtimeuse agent runtime.
 *
 * Handles message dispatch, artifact upload handshake, cancellation, and
 * structured result parsing.
 */
export class RuntimeUseClient {
  private readonly _transport: Transport;
  private _aborted = false;

  /**
   * @param options.wsUrl - WebSocket URL for the agent runtime. Used to
   *   create the default WebSocketTransport. Ignored when a custom transport
   *   is provided.
   * @param options.transport - Optional custom transport implementing the
   *   Transport interface. When provided, wsUrl is not required.
   */
  constructor(options?: { wsUrl?: string; transport?: Transport }) {
    if (options?.transport != null) {
      this._transport = options.transport;
    } else if (options?.wsUrl != null) {
      const ws = new WebSocketTransport(options.wsUrl);
      this._transport = ws.call;
    } else {
      throw new Error("Either wsUrl or transport must be provided");
    }
  }

  /**
   * Signal the current query to cancel.
   *
   * Sends a cancel message to the agent runtime and causes `query` to
   * throw `CancelledException`. Safe to call from any async context.
   */
  abort(): void {
    this._aborted = true;
  }

  /**
   * Send a prompt to the agent runtime and return the result.
   *
   * Builds an InvocationMessage from the prompt and options, sends it over
   * the transport, processes the response stream, and returns a QueryResult.
   *
   * @throws {AgentRuntimeError} If the runtime sends an error or no result is produced.
   * @throws {CancelledException} If the query is cancelled via `abort()`.
   * @throws {Error} If the timeout is exceeded (with name "TimeoutError").
   */
  async query(prompt: string, options: QueryOptions): Promise<QueryResult> {
    const logger: Logger = options.logger ?? defaultLogger;

    this._aborted = false;

    validateQueryOptions(options);

    const invocation: InvocationMessage = {
      message_type: "invocation_message",
      user_prompt: prompt,
      system_prompt: options.system_prompt,
      model: options.model,
      output_format_json_schema_str:
        options.output_format_json_schema_str ?? null,
      source_id: options.source_id ?? null,
      secrets_to_redact: options.secrets_to_redact ?? [],
      artifacts_dir: options.artifacts_dir ?? null,
      pre_agent_invocation_commands:
        options.pre_agent_invocation_commands ?? null,
      post_agent_invocation_commands:
        options.post_agent_invocation_commands ?? null,
      pre_agent_downloadables: options.pre_agent_downloadables ?? null,
    };

    const sendQueue = new AsyncQueue<Record<string, unknown>>();
    await sendQueue.put(invocation as unknown as Record<string, unknown>);

    let wireResult: ResultMessage | null = null;

    const runQuery = async (): Promise<void> => {
      for await (const message of this._transport(sendQueue)) {
        if (this._aborted) {
          logger.log("Query cancelled by caller");
          const cancelMsg: CancelMessage = {
            message_type: "cancel_message",
          };
          await sendQueue.put(
            cancelMsg as unknown as Record<string, unknown>,
          );
          await sendQueue.join();
          throw new CancelledException("Query was cancelled");
        }

        const msg = message as Record<string, unknown>;

        if (!isValidAgentRuntimeMessage(msg)) {
          logger.error(
            "Received unknown message type from agent runtime:",
            msg,
          );
          continue;
        }

        if (msg.message_type === "result_message") {
          wireResult = msg as unknown as ResultMessage;
          if (!wireResult.data) {
            throw new AgentRuntimeError(
              "Malformed result message: missing data field",
            );
          }
          logger.log("Received result message from agent runtime:", msg);
          continue;
        }

        if (msg.message_type === "assistant_message") {
          if (options.on_assistant_message != null) {
            await options.on_assistant_message(
              msg as unknown as Parameters<
                NonNullable<typeof options.on_assistant_message>
              >[0],
            );
          }
          continue;
        }

        if (msg.message_type === "error_message") {
          const errorMsg = msg as unknown as ErrorMessage;
          if (typeof errorMsg.error !== "string") {
            logger.error(
              "Received malformed error message from agent runtime:",
              msg,
            );
            throw new AgentRuntimeError(String(msg));
          }
          logger.error("Error from agent runtime:", errorMsg);
          throw new AgentRuntimeError(errorMsg.error, errorMsg.metadata);
        }

        if (msg.message_type === "artifact_upload_request_message") {
          logger.log(
            "Received artifact upload request message from agent runtime:",
            msg,
          );
          if (options.on_artifact_upload_request != null) {
            const request = msg as unknown as Parameters<
              NonNullable<typeof options.on_artifact_upload_request>
            >[0];
            const uploadResult =
              await options.on_artifact_upload_request(request);
            const response: ArtifactUploadResponseMessage = {
              message_type: "artifact_upload_response_message",
              filename: request.filename,
              filepath: request.filepath,
              presigned_url: uploadResult.presigned_url,
              content_type: uploadResult.content_type,
            };
            await sendQueue.put(
              response as unknown as Record<string, unknown>,
            );
          }
          continue;
        }

        logger.log("Received non-result message from agent runtime:", msg);
      }
    };

    if (options.timeout != null) {
      await withTimeout(runQuery(), options.timeout * 1000);
    } else {
      await runQuery();
    }

    if (wireResult === null) {
      throw new AgentRuntimeError("No result message received");
    }

    const finalResult: ResultMessage = wireResult;
    return {
      data: finalResult.data,
      metadata: finalResult.metadata,
    };
  }
}

function validateQueryOptions(options: QueryOptions): void {
  const hasDir = options.artifacts_dir != null;
  const hasCb = options.on_artifact_upload_request != null;
  if (hasDir !== hasCb) {
    throw new Error(
      "artifacts_dir and on_artifact_upload_request must be specified together",
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error("Timeout");
      err.name = "TimeoutError";
      reject(err);
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
