# Changelog

All notable changes. Versions follow [semantic versioning](https://semver.org); upgrade notes are in
[docs/upgrade.md](docs/upgrade.md).

## 0.2.0 (2026-11-28)

Keel is now something another team can install and run without help.

### Install and upgrade
- Published images: `ghcr.io/evanl666/keel:0.2.0`, `:0.2`, `:latest` (amd64 and arm64), the Helm chart at
  `oci://ghcr.io/evanl666/charts/keel`, and a wheel with the UI on each GitHub release.
- Setup needs a **setup code** from the server log, so a stranger can't claim a fresh install.
  `keel setup-code` prints it.
- Compose pins `KEEL_VERSION` (default `0.2`) and keeps backups in a `backups` volume.
- Helm: worker metrics port and Prometheus annotations, an optional nightly backup CronJob, documented
  `postgres.password`.
- New guides: install, Slack, GitHub, SSO and people, knowledge, backups, upgrades, operations.

### People
- **Invites**: org admins invite by email with an org role and teams; single-use links that expire in 7 days and
  can be withdrawn.
- **People** page: change roles, disable (signs the person out at once) or remove; the last admin is protected.
- **Team members**: team admins add, promote and remove members.
- **SSO**: ID tokens are verified (signature, issuer, audience, expiry, nonce); IdP groups map to teams
  (`sso_groups`, `KEEL_OIDC_GROUPS_CLAIM`); a pending invite applies on first SSO sign-in.
- `keel apply` accepts `members:` and `sso_groups:` per team.

### Slack
- `#channel` names are looked up and bound to the channel id (right away for public channels, on first message
  for private ones, and every 6 hours). The status line no longer claims "Watching #x" before that works.
- **DMs** work: the bot matches the Slack user to a Keel person by email and answers in the DM, within that
  person's clearance. People Keel can't place get one message saying what to ask for.
- `/keel ask` replies privately with source links; `/keel <request>` tags you in the team channel; `/keel help`.
- Answers end with `Sources:` links to the docs they used.
- Clearer errors when a token is wrong.

### GitHub
- **Polling** every 2 minutes when no webhook is set up, so GitHub works without a public URL
  (`KEEL_GITHUB_POLL=auto|on|off`). Webhook and poll share event ids, so nothing is handled twice.
- Webhook setup is documented.

### Knowledge
- Edit, delete and **mark reviewed**; review dates flag stale docs.
- **Synced sources**: a web page or a GitHub folder of Markdown, re-synced daily; deleted files drop out.
- `keel apply` no longer duplicates docs on re-run.
- Chinese, Japanese and Korean text is now searchable (character-pair tokens).

### Security and operations
- Login throttling (5 failures → 15 minutes, per email and per IP).
- Audit: members see only their teams' rows; org admins export CSV or JSON lines; optional retention
  (`KEEL_AUDIT_RETENTION_DAYS`).
- Team settings: rename, channel, repos, timezone, brief hour, SSO groups; delete a team (audit kept).
- Metrics: queue depth, unprocessed inbox, open commitments, pending approvals, steward level and stale docs per
  team; workers serve `/metrics` on 9464.
- `keel backup -o -` / `keel restore -` stream through stdin/stdout; restore works across `pg_dump` 17 →
  Postgres 16, runs in one transaction, migrates afterwards, and no longer puts the password on the command line.

### UI
- Redesigned: calmer, denser layout; new People, Team settings, Knowledge sources and Audit export screens.

## 0.1.0 (2026-11-26)

First release: per-team stewards with commitments, front desk, briefs, service checks, cross-team requests and
checkups; learning from corrections; earned trust levels; the write gateway with reconciliation; Slack, GitHub,
OIDC; setup wizard; web UI; `keel apply`, `keel runner`, `keel promises`, `keel wrapped`, `keel mcp`; Compose
and Helm.
