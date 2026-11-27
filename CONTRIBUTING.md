# Contributing to Keel

Thanks for helping. Small, focused pull requests get reviewed fastest.

## Set up

```bash
uv sync --extra all
(cd web && npm ci)
uv run pytest                      # SQLite, a few seconds
(cd web && npm run lint && npm run build)
keel demo --fresh                  # see your change in the demo
```

Postgres: `KEEL_TEST_DATABASE_URL=postgresql+psycopg://keel:keel@127.0.0.1:5432/keel uv run pytest`.
Live model runs: `KEEL_LIVE_PROVIDER=claude_code uv run pytest -m live` (or `anthropic` with `KEEL_MODEL_API_KEY`).

## House rules

- Import the module, not names from it: `from keel import ledger` then `ledger.create(...)`.
- Docstrings and type hints on every function. Named constants with a short reason instead of magic numbers.
- Tests for the normal, empty and single-item cases. A bug fix comes with a test that fails without it.
- Every outbound write goes through `gateway`; never call Slack or GitHub directly from a feature.
- UI copy is short and plain. When something fails, say why in one line.
- `uv run ruff check src tests && uv run ruff format src tests` before you push.

## Commit messages

Short and imperative, describing the outcome: "Show due days in the team's timezone".
