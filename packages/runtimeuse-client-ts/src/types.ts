export interface Command {
  command: string;
  cwd?: string;
}

export interface RuntimeEnvironmentDownloadable {
  download_url: string;
  working_dir: string;
}

export interface InvocationMessage {
  message_type: "invocation_message";
  source_id?: string;
  system_prompt: string;
  user_prompt: string;
  output_format_json_schema_str?: string;
  secrets_to_redact: string[];
  artifacts_dir?: string;
  pre_agent_invocation_commands?: Command[];
  post_agent_invocation_commands?: Command[];
  model: string;
  pre_agent_downloadables?: RuntimeEnvironmentDownloadable[];
}

export interface TextResult {
  type: "text";
  text: string;
}

export interface StructuredOutputResult {
  type: "structured_output";
  structured_output: Record<string, unknown>;
}

export interface QueryResult {
  metadata?: Record<string, unknown>;
  data: TextResult | StructuredOutputResult;
}

export interface ResultMessage {
  message_type: "result_message";
  metadata?: Record<string, unknown>;
  data: TextResult | StructuredOutputResult;
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
  metadata?: Record<string, unknown>;
}

export interface CancelMessage {
  message_type: "cancel_message";
}

export interface ArtifactUploadResult {
  presigned_url: string;
  content_type: string;
}

export type OnAssistantMessageCallback = (
  message: AssistantMessage
) => Promise<void>;

export type OnArtifactUploadRequestCallback = (
  request: ArtifactUploadRequestMessage
) => Promise<ArtifactUploadResult>;

export interface Logger {
  info(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

const defaultLogger: Logger = {
  info: (msg, ...args) => console.log(msg, ...args),
  error: (msg, ...args) => console.error(msg, ...args),
};

export interface QueryOptions {
  system_prompt: string;
  model: string;
  output_format_json_schema_str?: string;
  source_id?: string;
  secrets_to_redact?: string[];
  artifacts_dir?: string;
  pre_agent_invocation_commands?: Command[];
  post_agent_invocation_commands?: Command[];
  pre_agent_downloadables?: RuntimeEnvironmentDownloadable[];
  on_assistant_message?: OnAssistantMessageCallback;
  on_artifact_upload_request?: OnArtifactUploadRequestCallback;
  timeout?: number;
  logger?: Logger;
}

export function validateQueryOptions(options: QueryOptions): void {
  const hasDir = options.artifacts_dir != null;
  const hasCb = options.on_artifact_upload_request != null;
  if (hasDir !== hasCb) {
    throw new Error(
      "artifacts_dir and on_artifact_upload_request must be specified together"
    );
  }
}

export { defaultLogger };

type KnownMessageType =
  | "result_message"
  | "assistant_message"
  | "artifact_upload_request_message"
  | "error_message";

const KNOWN_MESSAGE_TYPES = new Set<string>([
  "result_message",
  "assistant_message",
  "artifact_upload_request_message",
  "error_message",
]);

export function isKnownMessageType(
  value: string
): value is KnownMessageType {
  return KNOWN_MESSAGE_TYPES.has(value);
}
