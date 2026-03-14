import os
import asyncio
import json
from pydantic import BaseModel

from src.runtimeuse_client import (
    AssistantMessageInterface,
    AgentRuntimeError,
    RuntimeUseClient,
    QueryOptions,
    StructuredOutputResult,
    CommandInterface,
)


class Answer(BaseModel):
    answer: str


async def main():
    client = RuntimeUseClient(ws_url="ws://localhost:8080")

    async def on_assistant_message(message: AssistantMessageInterface):
        print(f"Assistant message: {message.text_blocks}")

    try:
        result = await client.query(
            prompt="Search the web to find the answer to the question: 'What is the population of France grouped by region? Once you find the answer, run a python script to compute the sum of the total population of France.'",
            options=QueryOptions(
                system_prompt="You are a helpful assistant.",
                model="gpt-5.4",
                output_format_json_schema_str=json.dumps(
                    {"type": "json_schema", "schema": Answer.model_json_schema()}
                ),
                source_id="my-source",
                pre_agent_invocation_commands=[
                    CommandInterface(
                        command="echo 'Hello, world!'",
                        cwd=os.getcwd(),
                        env={},
                    )
                ],
                on_assistant_message=on_assistant_message,
            ),
        )
        assert isinstance(result, StructuredOutputResult)
        print(f"Result: {result.structured_output}")
    except AgentRuntimeError as e:
        print(f"Error: {e.error}")


if __name__ == "__main__":
    asyncio.run(main())
