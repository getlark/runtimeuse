import type { Transport } from "./transports/transport.js";
import { WebSocketTransport } from "./transports/websocket-transport.js";
import { SendQueue } from "./send-queue.js";
import { AgentRuntimeError, CancelledException } from "./exceptions.js";
import {
  defaultLogger,
  isKnownMessageType,
  validateQueryOptions,
  type AssistantMessage,
  type ArtifactUploadRequestMessage,
  type ArtifactUploadResponseMessage,
  type CancelMessage,
  type ErrorMessage,
  type InvocationMessage,
  type QueryOptions,
  type QueryResult,
  type ResultMessage,
} from "./types.js";

export class RuntimeUseClient {
  private transport: Transport;
  private aborted = false;

  constructor(options: { wsUrl?: string; transport?: Transport }) {
    if (options.transport != null) {
      this.transport = options.transport;
    } else if (options.wsUrl != null) {
      const wst = new WebSocketTransport(options.wsUrl);
      this.transport = (sendQueue) => wst.call(sendQueue);
    } else {
      throw new Error("Either wsUrl or transport must be provided");
    }
  }

  abort(): void {
    this.aborted = true;
  }

  async query(prompt: string, options: QueryOptions): Promise<QueryResult> {
    validateQueryOptions(options);

    const logger = options.logger ?? defaultLogger;

    this.aborted = false;

    const invocation: InvocationMessage = {
      message_type: "invocation_message",
      user_prompt: prompt,
      system_prompt: options.system_prompt,
      model: options.model,
      output_format_json_schema_str: options.output_format_json_schema_str,
      source_id: options.source_id,
      secrets_to_redact: options.secrets_to_redact ?? [],
      artifacts_dir: options.artifacts_dir,
      pre_agent_invocation_commands: options.pre_agent_invocation_commands,
      post_agent_invocation_commands: options.post_agent_invocation_commands,
      pre_agent_downloadables: options.pre_agent_downloadables,
    };

    const sendQueue = new SendQueue();
    await sendQueue.put(invocation as unknown as Record<string, unknown>);

    let wireResult: ResultMessage | undefined;

    const runQuery = async (): Promise<void> => {
      for await (const message of this.transport(sendQueue)) {
        if (this.aborted) {
          logger.info("Query cancelled by caller");
          const cancelMsg: CancelMessage = {
            message_type: "cancel_message",
          };
          await sendQueue.put(
            cancelMsg as unknown as Record<string, unknown>
          );
          await sendQueue.join();
          throw new CancelledException("Query was cancelled");
        }

        const messageType = message.message_type as string | undefined;
        if (!messageType || !isKnownMessageType(messageType)) {
          logger.error(
            `Received unknown message type from agent runtime: ${JSON.stringify(message)}`
          );
          continue;
        }

        if (messageType === "result_message") {
          wireResult = message as unknown as ResultMessage;
          logger.info(
            `Received result message from agent runtime: ${JSON.stringify(message)}`
          );
          continue;
        }

        if (messageType === "assistant_message") {
          if (options.on_assistant_message != null) {
            const assistantMsg = message as unknown as AssistantMessage;
            await options.on_assistant_message(assistantMsg);
          }
          continue;
        }

        if (messageType === "error_message") {
          const errorMsg = message as unknown as ErrorMessage;
          if (typeof errorMsg.error !== "string") {
            logger.error(
              `Received malformed error message from agent runtime: ${JSON.stringify(message)}`
            );
            throw new AgentRuntimeError(JSON.stringify(message));
          }
          logger.error(`Error from agent runtime: ${JSON.stringify(errorMsg)}`);
          throw new AgentRuntimeError(
            errorMsg.error,
            errorMsg.metadata ?? undefined
          );
        }

        if (messageType === "artifact_upload_request_message") {
          logger.info(
            `Received artifact upload request message from agent runtime: ${JSON.stringify(message)}`
          );
          if (options.on_artifact_upload_request != null) {
            const uploadReq =
              message as unknown as ArtifactUploadRequestMessage;
            const uploadResult =
              await options.on_artifact_upload_request(uploadReq);
            const response: ArtifactUploadResponseMessage = {
              message_type: "artifact_upload_response_message",
              filename: uploadReq.filename,
              filepath: uploadReq.filepath,
              presigned_url: uploadResult.presigned_url,
              content_type: uploadResult.content_type,
            };
            await sendQueue.put(
              response as unknown as Record<string, unknown>
            );
          }
          continue;
        }

        logger.info(
          `Received non-result message from agent runtime: ${JSON.stringify(message)}`
        );
      }
    };

    if (options.timeout != null) {
      const timeoutMs = options.timeout * 1000;
      await Promise.race([
        runQuery(),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new TimeoutError("Query timed out")),
            timeoutMs
          );
        }),
      ]);
    } else {
      await runQuery();
    }

    if (wireResult == null) {
      throw new AgentRuntimeError("No result message received");
    }

    return {
      data: wireResult.data,
      metadata: wireResult.metadata,
    };
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}
