# Operations

## Processes

| Process | What | Scale |
| --- | --- | --- |
| `keel serve` | Web UI, API, Slack Socket Mode, and (unless `KEEL_RUN_WORKER_IN_PROCESS=false`) a worker | Compose runs one; Helm runs `web.replicas` |
| `keel worker` | The job queue: inbox, writes, briefs, health checks, GitHub polls, knowledge syncs, housekeeping | Any number; they coordinate through Postgres (`FOR UPDATE SKIP LOCKED`) |

No Redis, no broker. Postgres holds state and the queue.

## Health and metrics

- `/healthz`: the process is up. `/readyz`: the database answers and is migrated.
- Prometheus `/metrics` on the web port (8420) and on each worker (`KEEL_WORKER_METRICS_PORT`, 9464). The Helm
  chart adds `prometheus.io/scrape` annotations.

| Metric | Watch for |
| --- | --- |
| `keel_jobs_queued{kind}` | Growing steadily: workers can't keep up, or one kind is failing |
| `keel_inbox_unprocessed` | Above zero for minutes: the worker is down |
| `keel_approvals_pending{team}` | Drafts nobody is approving |
| `keel_commitments_open{team}` | Load per team |
| `keel_steward_level{team}` | A drop means a demotion (failures, a canary hit) |
| `keel_knowledge_stale{team}` | Docs past their review date |
| `keel_operations_total{kind,status}` | Write outcomes by final status |
| `keel_inbox_events_total{source,result}` | Slack/GitHub events in |

## Logs

One line per event, to stdout. On start, until an admin exists, Keel logs the setup URL and code.

## Settings

Every setting is an environment variable starting with `KEEL_`, or a line in `.env`. The setup wizard writes
connection credentials to the database (encrypted with `KEEL_SECRET_KEY`); an environment variable always wins.
See [`deploy/.env.example`](../deploy/.env.example).

## CLI

```bash
keel doctor           # checks everything, one line each
keel setup-code       # the code the setup page asks for
keel backup / restore # see backup.md
keel apply -f keel.yaml --dry-run
keel secret           # a new KEEL_SECRET_KEY
```
