interface Command {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

interface RuntimeEnvironmentDownloadable {
  download_url: string;
  working_dir: string;
}

interface InvocationMessage {
  message_type: "invocation_message";
  source_id?: string;
  system_prompt: string;
  user_prompt: string;
  secrets_to_redact: string[];
  output_format_json_schema_str: string;
  model: string;
  artifacts_dir?: string;
  pre_agent_invocation_commands?: Command[];
  post_agent_invocation_commands?: Command[];
  pre_agent_downloadables?: RuntimeEnvironmentDownloadable[];
}

interface CancelMessage {
  message_type: "cancel_message";
}

interface ResultMessage {
  message_type: "result_message";
  metadata?: Record<string, unknown>;
  structured_output: Record<string, unknown>;
  [key: string]: unknown;
}

interface AssistantMessage {
  message_type: "assistant_message";
  text_blocks: string[];
}

interface ArtifactUploadRequestMessage {
  message_type: "artifact_upload_request_message";
  filename: string;
  filepath: string;
}

interface ArtifactUploadResponseMessage {
  message_type: "artifact_upload_response_message";
  filename: string;
  filepath: string;
  presigned_url: string;
  content_type: string;
}

interface ErrorMessage {
  message_type: "error_message";
  error: string;
  metadata: Record<string, unknown>;
}

type OutgoingMessage =
  | ResultMessage
  | AssistantMessage
  | ArtifactUploadRequestMessage
  | ErrorMessage;

type IncomingMessage =
  | InvocationMessage
  | ArtifactUploadResponseMessage
  | CancelMessage;

export type {
  IncomingMessage,
  OutgoingMessage,
  InvocationMessage,
  CancelMessage,
  ResultMessage,
  AssistantMessage,
  ArtifactUploadRequestMessage,
  ArtifactUploadResponseMessage,
  ErrorMessage,
  Command,
  RuntimeEnvironmentDownloadable,
};
