import os
import asyncio
import json
from pydantic import BaseModel

from src.runtimeuse_client import (
    AssistantMessageInterface,
    AgentRuntimeError,
    ExecuteCommandsOptions,
    RuntimeUseClient,
    QueryOptions,
    StructuredOutputResult,
    CommandInterface,
)


class FrenchWordsAnswer(BaseModel):
    words: list[str]


class PopulationAnswer(BaseModel):
    population: int


async def main():
    client = RuntimeUseClient(ws_url="ws://localhost:8080")

    async def on_assistant_message(message: AssistantMessageInterface):
        print(f"Assistant message: {message.text_blocks}")

    try:
        async with client.session() as session:
            result = await session.query(
                prompt="Search the web to find the answer to the question: 'What is the population of France?'",
                options=QueryOptions(
                    system_prompt="You are a helpful assistant.",
                    model="gpt-5.4",
                    pre_agent_invocation_commands=[
                        CommandInterface(
                            command="echo 'Running pre-agent command'",
                            cwd=os.getcwd(),
                            env={},
                        )
                    ],
                    post_agent_invocation_commands=[
                        CommandInterface(
                            command="echo 'Running post-agent command'",
                            cwd=os.getcwd(),
                            env={},
                        )
                    ],
                    output_format_json_schema_str=json.dumps(
                        {
                            "type": "json_schema",
                            "schema": PopulationAnswer.model_json_schema(),
                        }
                    ),
                    source_id="my-source",
                    on_assistant_message=on_assistant_message,
                ),
            )
            assert isinstance(result.data, StructuredOutputResult)
            population = result.data.structured_output["population"]
            print(f"Population: {population}")

            if population > 5:
                print("Population is greater than 5, will say bonjour")
                result = await session.execute_commands(
                    commands=[
                        CommandInterface(
                            command="echo 'Bonjour!'",
                            cwd=os.getcwd(),
                            env={},
                        ),
                        CommandInterface(
                            command="exit 1",
                            cwd=os.getcwd(),
                            env={},
                        ),
                    ],
                    options=ExecuteCommandsOptions(),
                )
                print(f"Command result: {result}")
                result = await session.query(
                    prompt="Give me 6 french words",
                    options=QueryOptions(
                        system_prompt="You are a helpful assistant.",
                        model="gpt-5.4",
                        output_format_json_schema_str=json.dumps(
                            {
                                "type": "json_schema",
                                "schema": FrenchWordsAnswer.model_json_schema(),
                            }
                        ),
                    ),
                )
                assert isinstance(result.data, StructuredOutputResult)
                french_words = result.data.structured_output["words"]
                print(f"French words: {french_words}")
    except AgentRuntimeError as e:
        print(f"Error: {e.error}")


if __name__ == "__main__":
    asyncio.run(main())
