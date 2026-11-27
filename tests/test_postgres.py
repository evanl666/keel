"""Postgres only: concurrent workers never claim the same job (FOR UPDATE SKIP LOCKED).

Run with: KEEL_TEST_DATABASE_URL=postgresql+psycopg://keel:keel@localhost:5432/keel pytest -m postgres
"""

from __future__ import annotations

import concurrent.futures
import os

import pytest

from keel import db, jobs, models

pytestmark = [
    pytest.mark.postgres,
    pytest.mark.skipif(not os.environ.get("KEEL_TEST_DATABASE_URL"), reason="needs KEEL_TEST_DATABASE_URL"),
]

JOB_COUNT = 200
WORKERS = 8


def test_parallel_claims_are_disjoint(team: models.Team) -> None:
    with db.session() as s:
        for i in range(JOB_COUNT):
            jobs.enqueue(s, team.org_id, "nudge", {"i": i})

    def grab(worker: int) -> list[str]:
        mine: list[str] = []
        while batch := jobs.claim(f"w{worker}", limit=7):
            mine.extend(batch)
        return mine

    with concurrent.futures.ThreadPoolExecutor(WORKERS) as pool:
        results = list(pool.map(grab, range(WORKERS)))
    claimed = [j for r in results for j in r]
    assert len(claimed) == JOB_COUNT
    assert len(set(claimed)) == JOB_COUNT
    assert sum(1 for r in results if r) > 1, "work should spread across workers"
