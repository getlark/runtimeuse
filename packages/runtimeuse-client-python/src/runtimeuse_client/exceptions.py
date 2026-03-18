import json


class CancelledException(Exception):
    """Raised when an agent runtime invocation is cancelled."""

    pass


class AgentRuntimeError(Exception):
    """Raised when the agent runtime returns an error message."""

    def __init__(self, error: str, metadata: dict | None = None):
        super().__init__(error)
        self.error = error
        self.metadata = metadata

    def __str__(self) -> str:
        if not self.metadata:
            return self.error

        try:
            metadata_str = json.dumps(self.metadata, sort_keys=True, default=str)
        except TypeError:
            metadata_str = str(self.metadata)

        return f"{self.error}\nmetadata: {metadata_str}"
