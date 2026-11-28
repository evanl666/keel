# Install Keel

About 15 minutes from nothing to a steward answering in Slack. You write no code: you run a container, click
through a setup page, and invite your team.

| You need | Why |
| --- | --- |
| A Linux or macOS host with Docker (or a Kubernetes cluster with Helm) | Keel runs as one container plus Postgres |
| A model API key (Anthropic, OpenAI, Azure OpenAI) or an Ollama server | Triage and answers. Without one, Keel runs on rules |
| A Slack workspace where you can create apps | Optional, but it's where teams talk to their steward |
| A GitHub token or GitHub App | Optional: issues, PRs and repo checkups |

Keel makes **no inbound connections from Slack**: Slack uses Socket Mode. GitHub works without a public URL too
(Keel polls every 2 minutes); webhooks are optional.

## 1. Start it (Docker Compose)

```bash
mkdir keel && cd keel
curl -fsSLO https://raw.githubusercontent.com/evanl666/keel/main/deploy/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/evanl666/keel/main/deploy/.env.example -o .env
docker run --rm ghcr.io/evanl666/keel:0.2 secret        # copy the output
```

Open `.env` and set:

- `KEEL_SECRET_KEY` to the value you just copied. It encrypts stored credentials; **back it up**. Without it,
  a restored database can't read its Slack/GitHub/model credentials.
- `POSTGRES_PASSWORD` to any long random string.
- `KEEL_BASE_URL` to the address people will open (e.g. `https://keel.acme.internal`). Invite links and Slack
  source links use it.

```bash
docker compose --env-file .env up -d
docker compose logs keel | grep "setup code"
#   Keel isn't set up yet. Open https://keel.acme.internal/setup and enter the setup code: 7Q2M-K9XD
```

Postgres is created and migrated for you on first start. There's nothing to run by hand.

> **Why a setup code?** Until an admin exists, whoever opens `/setup` first could claim the install. The code is
> printed only in the server log, so only someone with access to the server can finish setup. `keel setup-code`
> prints it again; `KEEL_SECRET_KEY` derives it, or set your own with `KEEL_SETUP_CODE`.

Behind a TLS proxy (nginx, Caddy, a cloud load balancer), forward to port 8420. Keel marks cookies `Secure` when
`KEEL_BASE_URL` starts with `https://`.

## 2. The setup page

Open the URL. Each step tests the connection before it saves and says in one line why it failed:

1. **Admin**: your name, email, password, the organisation name, and the setup code.
2. **Model**: provider, model, key. "Skip" runs on rules.
3. **Slack**: see [slack.md](slack.md). Takes 3 minutes with the manifest.
4. **GitHub**: a token (fine-grained, read/write on issues and pull requests) or a GitHub App. See
   [github.md](github.md).
5. **Policy**: the level new stewards start at (L1 Draft is the safe default: every message waits for approval).
6. **First team**: a name, a steward name, the team's Slack channel (`#payments` or its id) and repos.

## 3. Bring in your team

**People → Invite**: an email, an org role, and the teams they join. You get a link to send them (Keel
doesn't send email). The link works once and expires after 7 days. With SSO, people can sign in directly and
are placed on teams by their IdP groups; see [sso.md](sso.md).

Team admins add org members to their own team from the team's **Settings → Members**.

## 4. Ask the steward something

- Add a doc: the team's **Knowledge → Add**, or sync a wiki page or a GitHub docs folder (**Knowledge →
  Sources**, see [knowledge.md](knowledge.md)).
- In the team's Slack channel: `@keel who approves refunds over $10k?`. It answers in the thread with links to
  the docs it used.
- Or privately: `/keel ask who approves refunds over $10k?`, or DM the bot.

## Kubernetes (Helm)

```bash
# The chart is on ghcr.io; from a checkout, use deploy/helm/keel instead.
helm install keel oci://ghcr.io/evanl666/charts/keel --version 0.2.0 \
  --set secretKey=$(docker run --rm ghcr.io/evanl666/keel:0.2 secret) \
  --set database.url='postgresql+psycopg://keel:PASS@db.internal:5432/keel' \
  --set baseUrl=https://keel.example.com \
  --set ingress.enabled=true --set ingress.host=keel.example.com
kubectl logs deploy/keel-web -c web | grep "setup code"
```

The chart runs web and worker Deployments separately, migrates in an init container (one replica migrates under
a Postgres advisory lock; the others wait), runs as uid 10001 with a read-only root filesystem, and exposes
`/healthz`, `/readyz` and Prometheus `/metrics` (web on 8420, workers on 9464). For a trial without a database,
`--set postgres.enabled=true --set postgres.password=<any long random string>` bundles one; use a managed Postgres
in production. `--set backup.enabled=true` adds a nightly backup CronJob (see [backup.md](backup.md)).

The Helm chart is attached to each [GitHub release](https://github.com/evanl666/keel/releases) as
`keel-<version>.tgz`; `helm install keel ./keel-0.2.0.tgz` works too.

## Check it

```bash
docker compose exec keel keel doctor
```

`keel doctor` checks the database, migrations, secret key, model, Slack, GitHub and web UI, one line each.

Next: [Slack](slack.md) · [GitHub](github.md) · [SSO and people](sso.md) · [Knowledge](knowledge.md) ·
[Backups](backup.md) · [Upgrades](upgrade.md) · [Operations](operations.md)
