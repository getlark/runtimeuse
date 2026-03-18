export interface Command {
  command: string;
  cwd?: string | null;
}

export interface RuntimeEnvironmentDownloadable {
  download_url: string;
  working_dir: string;
}

export interface InvocationMessage {
  message_type: "invocation_message";
  source_id?: string | null;
  system_prompt: string;
  user_prompt: string;
  output_format_json_schema_str?: string | null;
  secrets_to_redact: string[];
  artifacts_dir?: string | null;
  pre_agent_invocation_commands?: Command[] | null;
  post_agent_invocation_commands?: Command[] | null;
  model: string;
  pre_agent_downloadables?: RuntimeEnvironmentDownloadable[] | null;
}

export interface TextResult {
  type: "text";
  text: string;
}

export interface StructuredOutputResult {
  type: "structured_output";
  structured_output: Record<string, unknown>;
}

export type ResultData = TextResult | StructuredOutputResult;

export interface QueryResult {
  metadata?: Record<string, unknown> | null;
  data: ResultData;
}

export interface ResultMessage {
  message_type: "result_message";
  metadata?: Record<string, unknown> | null;
  data: ResultData;
}

export interface AssistantMessage {
  message_type: "assistant_message";
  text_blocks: string[];
}

export interface ArtifactUploadRequestMessage {
  message_type: "artifact_upload_request_message";
  filename: string;
  filepath: string;
}

export interface ArtifactUploadResponseMessage {
  message_type: "artifact_upload_response_message";
  filename: string;
  filepath: string;
  presigned_url: string;
  content_type: string;
}

export interface ErrorMessage {
  message_type: "error_message";
  error: string;
  metadata?: Record<string, unknown> | null;
}

export interface CancelMessage {
  message_type: "cancel_message";
}

export interface ArtifactUploadResult {
  presigned_url: string;
  content_type: string;
}

export type OnAssistantMessageCallback = (
  message: AssistantMessage,
) => Promise<void>;

export type OnArtifactUploadRequestCallback = (
  message: ArtifactUploadRequestMessage,
) => Promise<ArtifactUploadResult>;

export type AgentRuntimeMessageType =
  | "result_message"
  | "assistant_message"
  | "artifact_upload_request_message"
  | "error_message";

const VALID_MESSAGE_TYPES: Set<string> = new Set([
  "result_message",
  "assistant_message",
  "artifact_upload_request_message",
  "error_message",
]);

export function isValidAgentRuntimeMessage(
  msg: Record<string, unknown>,
): msg is Record<string, unknown> & { message_type: AgentRuntimeMessageType } {
  return (
    typeof msg.message_type === "string" &&
    VALID_MESSAGE_TYPES.has(msg.message_type)
  );
}

export interface Logger {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
}

export const defaultLogger: Logger = {
  log: (...args: unknown[]) => console.log(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
};

export interface QueryOptions {
  system_prompt: string;
  model: string;
  output_format_json_schema_str?: string | null;
  source_id?: string | null;
  secrets_to_redact?: string[];
  artifacts_dir?: string | null;
  pre_agent_invocation_commands?: Command[] | null;
  post_agent_invocation_commands?: Command[] | null;
  pre_agent_downloadables?: RuntimeEnvironmentDownloadable[] | null;
  on_assistant_message?: OnAssistantMessageCallback | null;
  on_artifact_upload_request?: OnArtifactUploadRequestCallback | null;
  /** Overall timeout in seconds for the query. `null`/`undefined` means no limit. */
  timeout?: number | null;
  logger?: Logger | null;
}
