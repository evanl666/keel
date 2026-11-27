"""Connector interface. A connector executes an operation and can later tell whether it happened."""

from __future__ import annotations

import dataclasses
import enum
import typing

from keel import models


@dataclasses.dataclass
class ExecResult:
    """A write the remote side acknowledged."""

    remote_ref: str
    pending: bool = False  # True when an out-of-process runner will finish it (runbooks).


class Found(enum.Enum):
    """Answer from reconciliation."""

    YES = "yes"  # The write exists remotely.
    NO = "no"  # Checked an authoritative listing: it does not exist.
    UNSURE = "unsure"  # Couldn't tell (listing failed, too soon, or not checkable).


@dataclasses.dataclass
class ReconcileResult:
    """What reconciliation found, with the remote ref when it exists."""

    found: Found
    remote_ref: str | None = None
    line: str = ""


class Connector(typing.Protocol):
    """Implemented by Slack, GitHub, the demo simulator, the cross-team bridge and the runbook runner."""

    def execute(self, op: models.Operation) -> ExecResult:
        """Send the write. Raise :class:`keel.errors.ConnectorError` on failure."""
        ...

    def reconcile(self, op: models.Operation) -> ReconcileResult:
        """Look for the write by its op_id after an unknown outcome."""
        ...


OP_MARKER = "keel-op"


def marker(op_id: str) -> str:
    """Hidden marker embedded in remote content so reconciliation can find it by op_id."""
    return f"<!-- {OP_MARKER}: {op_id} -->"
