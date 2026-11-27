"""L4 runbooks. Keel never reaches into production: an outbound-only runner polls for approved work.

The runner (``keel runner``) runs next to the services, holds ``KEEL_RUNNER_TOKEN``, claims ``runbook.run``
operations over HTTPS, runs only commands from its own local allow-list, and reports back.
"""

from __future__ import annotations

from keel import models
from keel.connectors import base


class RunnerConnector:
    """Hands the operation to the runner by leaving it in ``dispatching`` until the runner reports."""

    checkable = False  # Reconciliation can't learn more by asking again.

    def execute(self, op: models.Operation) -> base.ExecResult:
        """Nothing to call: the runner pulls. The lease in the gateway bounds how long we wait."""
        return base.ExecResult(remote_ref="runner:pending", pending=True)

    def reconcile(self, op: models.Operation) -> base.ReconcileResult:
        """A command's effect can't be looked up by op_id, so a person decides."""
        return base.ReconcileResult(
            base.Found.UNSURE,
            line="The runner stopped reporting mid-run, and a command's effect can't be looked up.",
        )
