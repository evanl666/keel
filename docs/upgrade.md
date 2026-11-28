# Upgrading

Keel follows semantic versioning. Patch releases (0.2.x) are drop-in. Minor releases (0.x → 0.y) may add
settings; read the [CHANGELOG](../CHANGELOG.md) first. Database migrations run automatically on start.

## Docker Compose

```bash
docker compose exec keel keel backup          # always first
# in .env: KEEL_VERSION=0.2  (follows patches) or pin, e.g. KEEL_VERSION=0.2.1
docker compose --env-file .env pull
docker compose --env-file .env up -d
docker compose exec keel keel doctor
```

## Helm

```bash
kubectl exec deploy/keel-web -c web -- keel backup -o - > before-upgrade.dump
helm upgrade keel oci://ghcr.io/evanl666/charts/keel --version 0.2.1 --reuse-values
```

The `migrate` init container upgrades the schema before new pods start; it holds a Postgres advisory lock, so
one replica migrates and the rest wait. Old pods keep serving until the new ones are ready.

## Rolling back

Every migration has a downgrade step, but the safe path is the backup:

```bash
docker compose exec -T keel keel restore - --yes < before-upgrade.dump    # then start the old version
```

## From 0.1 to 0.2

- **Setup code.** A fresh install now asks for a setup code from the server log. Existing installs aren't
  affected (they already have an admin).
- **Image tag.** Compose now uses `ghcr.io/evanl666/keel:${KEEL_VERSION:-0.2}` instead of `:latest`.
- **GitHub polling** is on by default when no webhook secret is set. Set `KEEL_GITHUB_POLL=off` to keep 0.1's
  webhook-only behaviour.
- **Slack channel names** typed as `#name` are now looked up and bound. Check each team's status line after
  upgrading; invite the bot to private channels.
- **New settings** (all optional): `KEEL_SETUP_CODE`, `KEEL_GITHUB_POLL`, `KEEL_OIDC_GROUPS_CLAIM`,
  `KEEL_AUDIT_RETENTION_DAYS`, `KEEL_LOGIN_MAX_FAILURES`, `KEEL_LOGIN_LOCKOUT_MINUTES`, `KEEL_BACKUP_DIR`,
  `KEEL_WORKER_METRICS_PORT`.
- Migration `0003` adds invites, login throttling, knowledge sources and review dates. It runs on start.
