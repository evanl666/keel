"""keel apply: idempotent, never deletes, never raises a level."""

from __future__ import annotations

import pathlib
import shutil

import pytest
import sqlalchemy as sa

from keel import db, gitops, models

EXAMPLES = pathlib.Path(__file__).resolve().parents[1] / "examples"


@pytest.fixture
def plan_path(tmp_path: pathlib.Path, database: str) -> pathlib.Path:
    shutil.copytree(EXAMPLES, tmp_path / "ex")
    return tmp_path / "ex" / "keel.yaml"


def _apply(path: pathlib.Path, dry_run: bool = False) -> list[tuple[str, str]]:
    plan = gitops.load(path)
    with db.session() as s:
        return gitops.apply(s, plan, path.parent, dry_run=dry_run)


def _counts() -> tuple[int, int, int]:
    with db.session() as s:
        return tuple(
            s.scalar(sa.select(sa.func.count()).select_from(m))
            for m in (models.Team, models.Service, models.KnowledgeDoc)
        )


def test_dry_run_changes_nothing(plan_path: pathlib.Path) -> None:
    changes = _apply(plan_path, dry_run=True)
    assert any(kind == "create" for kind, _ in changes)
    assert _counts() == (0, 0, 0)


def test_apply_then_reapply_is_a_no_op(plan_path: pathlib.Path) -> None:
    _apply(plan_path)
    after_first = _counts()
    assert after_first[0] == 2
    second = _apply(plan_path)
    assert [c for c in second if c[0] in ("create", "update")] == [], second
    assert _counts() == after_first


def test_file_can_lower_but_never_raise_a_level(plan_path: pathlib.Path) -> None:
    _apply(plan_path)
    text = plan_path.read_text().replace("  - slug: payments\n", "  - slug: payments\n    level: 4\n", 1)
    plan_path.write_text(text)
    changes = _apply(plan_path)
    assert any(kind == "skip" and "raising a level needs a person" in line for kind, line in changes)
    with db.session() as s:
        team = s.scalar(sa.select(models.Team).where(models.Team.slug == "payments"))
        steward = s.scalar(sa.select(models.Steward).where(models.Steward.team_id == team.id))
        assert steward.level == 1
        steward.level = 3
    plan_path.write_text(text.replace("level: 4", "level: 2"))
    changes = _apply(plan_path)
    assert ("update", "payments level lowered to L2") in changes


def test_removing_a_team_from_the_file_keeps_it(plan_path: pathlib.Path) -> None:
    _apply(plan_path)
    text = plan_path.read_text()
    plan_path.write_text(text[: text.index("  - slug: platform")])
    _apply(plan_path)
    assert _counts()[0] == 2


def test_bad_file_is_a_clear_error(tmp_path: pathlib.Path, database: str) -> None:
    bad = tmp_path / "bad.yaml"
    bad.write_text("teams:\n  - name: no slug\n")
    with pytest.raises(ValueError):
        gitops.load(bad)
