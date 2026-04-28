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
  agent_env?: Record<string, string>;
  secrets_to_redact: string[];
  output_format_json_schema_str?: string;
  model: string;
  artifacts_dir?: string;
  pre_agent_invocation_commands?: Command[];
  post_agent_invocation_commands?: Command[];
  pre_agent_downloadables?: RuntimeEnvironmentDownloadable[];
}

interface CommandExecutionMessage {
  message_type: "command_execution_message";
  source_id?: string;
  secrets_to_redact: string[];
  commands: Command[];
  artifacts_dir?: string;
  pre_execution_downloadables?: RuntimeEnvironmentDownloadable[];
}

interface CommandExecutionResultItem {
  command: string;
  exit_code: number;
  stdout?: string;
}

interface CommandExecutionResultMessage {
  message_type: "command_execution_result_message";
  results: CommandExecutionResultItem[];
}

interface CancelMessage {
  message_type: "cancel_message";
}

interface EndSessionMessage {
  message_type: "end_session_message";
}

interface ResultMessage {
  message_type: "result_message";
  metadata?: Record<string, unknown>;
  data:
  | { type: "text"; text: string }
  | { type: "structured_output"; structured_output: Record<string, unknown> };
  [key: string]: unknown;
}

interface AssistantMessage {
  message_type: "assistant_message";
  text_blocks: string[];
}

interface CommandOutputMessage {
  message_type: "command_output_message";
  stream: "stdout" | "stderr";
  text: string;
  command: string;
}

interface HeartbeatMessage {
  message_type: "heartbeat_message";
  phase: string;
  elapsed_ms: number;
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

interface EndSessionConfirmMessage {
  message_type: "end_session_confirm_message";
}

type OutgoingMessage =
  | ResultMessage
  | AssistantMessage
  | CommandOutputMessage
  | HeartbeatMessage
  | ArtifactUploadRequestMessage
  | ErrorMessage
  | CommandExecutionResultMessage
  | EndSessionConfirmMessage;

type IncomingMessage =
  | InvocationMessage
  | CommandExecutionMessage
  | ArtifactUploadResponseMessage
  | CancelMessage
  | EndSessionMessage;

export type {
  IncomingMessage,
  OutgoingMessage,
  InvocationMessage,
  CommandExecutionMessage,
  CommandExecutionResultMessage,
  CommandExecutionResultItem,
  CancelMessage,
  EndSessionMessage,
  ResultMessage,
  AssistantMessage,
  CommandOutputMessage,
  HeartbeatMessage,
  ArtifactUploadRequestMessage,
  ArtifactUploadResponseMessage,
  ErrorMessage,
  EndSessionConfirmMessage,
  Command,
  RuntimeEnvironmentDownloadable,
};
