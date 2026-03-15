class CancelledException(Exception):
    """Raised when an agent runtime invocation is cancelled."""

    pass


class AgentRuntimeError(Exception):
    """Raised when the agent runtime returns an error message."""

    def __init__(self, error: str, metadata: dict | None = None):
        super().__init__(error)
        self.error = error
        self.metadata = metadata
