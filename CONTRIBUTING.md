# Contributing

Thanks for contributing to `runtimeuse`.

## Prerequisites

- Git
- Node.js 22 or newer
- Python 3.11 or newer recommended
- `npm`

There is no root workspace setup in this repository today, so install dependencies separately in each package you want to work on.

## Clone the Repository

```bash
git clone https://github.com/getlark/runtimeuse.git
cd runtimeuse
```

## Repository Layout

- `packages/runtimeuse` is the TypeScript runtime that runs inside the sandbox.
- `packages/runtimeuse-client-python` is the Python client used outside the sandbox.
- `docs` is the documentation app.

## Environment Files

Two local env files are useful for advanced development flows. They are not required for the basic local test path:

- `packages/runtimeuse/.env` for the runtime package's `npm run dev-publish` flow. Start from `packages/runtimeuse/.env.example`.
- `packages/runtimeuse-client-python/.env` for sandbox and LLM tests. Start from `packages/runtimeuse-client-python/.env.example`.

## TypeScript Runtime Development

Install dependencies:

```bash
cd packages/runtimeuse
npm install
```

Useful commands:

```bash
npm run build
npm run typecheck
npm test
npm run test:integration
```

Notes:

- `npm test` runs the main unit test suite.
- `npm run test:integration` builds first and then runs the integration tests.
- If you want to use the Claude handler locally, install the CLI with `npm install -g @anthropic-ai/claude-code`.
- `npm run dev-publish` runs `scripts/dev-publish.sh`: it builds the runtime, uploads a zip to S3, and prints a presigned download URL plus a ready-to-use `curl ... && node runtimeuse/dist/cli.js` command.
- `npm run dev-publish` reads `packages/runtimeuse/.env` for `S3_BUCKET` and optionally `S3_PREFIX` and `PRESIGN_EXPIRY`.
- `npm run dev-publish` assumes the AWS CLI is installed and already authenticated with permission to upload to the configured S3 bucket and generate presigned URLs.

## Python Client Development

Create and activate a virtual environment, then install the package in editable mode:

```bash
cd packages/runtimeuse-client-python
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]" 2>/dev/null || pip install -e .
pip install pytest pytest-asyncio
```

Run the default test suite:

```bash
pytest test/ -m "not sandbox and not llm"
```

Sandbox-only test flow:

```bash
pytest test/ -m sandbox
```

LLM-only test flow:

```bash
pytest test/ -m llm
```

Notes:

- The Python package declares `python >=3.10`, but CI currently tests on Python 3.11 through 3.13.
- If your change touches the runtime protocol or end-to-end behavior, build `packages/runtimeuse` before running Python tests:

```bash
cd packages/runtimeuse
npm install
npm run build
```

- Copy `packages/runtimeuse-client-python/.env.example` to `.env` before running sandbox or LLM tests locally.
- Sandbox tests create an E2B sandbox and require `E2B_API_KEY`.
- LLM tests also create sandboxes by default and require `E2B_API_KEY` plus the relevant provider credentials such as `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
- If you already have a runtime server running, set `TEST_WS_URL` to reuse it instead of creating a fresh sandbox.
- Some LLM tests also require `TEST_S3_BUCKET` for artifact upload verification.
- If you want sandbox tests to run against a dev build instead of `npx -y runtimeuse`, set `RUNTIMEUSE_RUN_COMMAND`. A convenient way to get that command is `packages/runtimeuse` -> `npm run dev-publish`.

## Docs Development

Install and run the docs app:

```bash
cd docs
npm install
npm run dev
```

Useful commands:

```bash
npm run build
npm run types:check
npm run lint
```

## Before Opening a PR

Run the checks relevant to the package you changed:

- `packages/runtimeuse`: `npm run typecheck` and `npm test`
- `packages/runtimeuse-client-python`: `pytest test/ -m "not sandbox and not llm"`
- `docs`: `npm run types:check` and `npm run lint`

If you changed behavior shared between the runtime and Python client, run both the TypeScript and Python checks.
