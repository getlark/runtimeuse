import os
import asyncio
import json
from pydantic import BaseModel

from runtimeuse_client import (
    AssistantMessageInterface,
    ErrorMessageInterface,
    RuntimeUseClient,
    InvocationMessage,
    ResultMessageInterface,
    CommandInterface,
)


class Answer(BaseModel):
    answer: str


async def main():
    client = RuntimeUseClient(ws_url="ws://localhost:8080")
    invocation = InvocationMessage(
        message_type="invocation_message",
        source_id="my-source",
        preferred_model="gpt-5.4",
        pre_agent_invocation_commands=[
            CommandInterface(
                command="echo 'Hello, world!'",
                cwd=os.getcwd(),
                env={},
            )
        ],
        system_prompt="You are a helpful assistant.",
        user_prompt="Search the web to find the answer to the question: 'What is the population of France grouped by region? Once you find the answer, run a python script to compute the sum of the total population of France.'",
        output_format_json_schema_str=json.dumps(
            {"type": "json_schema", "schema": Answer.model_json_schema()}
        ),
        secrets_to_redact=[],
        agent_env={},
    )

    async def on_result(result: ResultMessageInterface):
        print(f"Result: {result.structured_output}")

    async def on_assistant_message(message: AssistantMessageInterface):
        print(f"Assistant message: {message.text_blocks}")

    async def on_error_message(message: ErrorMessageInterface):
        print(f"Error message: {message.error}")

    await client.invoke(
        invocation=invocation,
        on_result_message=on_result,
        result_message_cls=ResultMessageInterface,
        on_assistant_message=on_assistant_message,
        on_error_message=on_error_message,
    )


if __name__ == "__main__":
    asyncio.run(main())
