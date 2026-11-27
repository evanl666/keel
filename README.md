# ⚓ Keel

**One AI steward for every team.** Keel gives each team a steward that keeps its promises on the books, answers
the front desk, runs the daily rhythm, watches its services and carries requests between teams, and only does
what the team has trusted it to do.

[中文说明](#中文) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Deploy](#deploy) · [API](docs/api.md)

```bash
pipx install keel-steward      # or: uv tool install keel-steward
keel demo                      # a live company of three teams in your browser, no keys needed
```

---

## What a steward does

| Duty | What you see |
| --- | --- |
| **Ledger** | "Can someone rotate the webhook secret by Friday?" in Slack becomes **C-88**, with an owner, a due date and a risk light. Later "C-88 is done" closes it. |
| **Front desk** | Anyone can ask the team's steward. Answers come from the team's notes, with sources. Restricted notes are never quoted, and the reply says how many were left out. |
| **Rhythm** | A short daily brief per team: what's due, what slipped, what's blocked. |
| **Services** | Health checks on the team's services. An outage opens an urgent commitment, recovery closes it. Allow-listed runbooks at L4. |
| **Cross-team** | Platform's steward can ask Payments' steward for work. It lands in Payments' ledger, linked both ways. |
| **Chores** | Repo checkups (stale PRs, waiting reviews, failing CI) and reminders. |

### Trust levels: earned, not configured

| Level | The steward may, on its own |
| --- | --- |
| L0 Observe | Read and keep the ledger. Sends nothing. |
| L1 Draft | Nothing. Every message waits for a person to approve. |
| L2 Assist | Post in its own channel, reply in threads, remind. |
| L3 Act | Also file issues, comment, and ask other teams. |
| L4 Operate | Also run allow-listed runbooks through the outbound runner. |

Every approve, edit or reject is a sample. A steward earns the next level at 50 samples with ≥95% approved
unedited in 30 days, and a person signs off. Three failed or rejected actions in a day step it down a level.
A YAML file can lower a level but never raise one.

## Quickstart

### 1. Try it: `keel demo` (2 minutes, nothing to configure)

```bash
pipx install keel-steward
keel demo
```

You get a seeded company (Acme: Payments 🦉 Pip, Platform 🦫 Bolt, Mobile 🐙 Echo) on SQLite in `~/.keel/demo.db`.
Press **Play the story** to watch nine scripted moments: a request turns into a commitment, a draft waits for
approval, an outage opens and closes an incident, a GitHub write loses its response and Keel checks before
retrying, and a leak attempt is blocked by a canary. Slack and GitHub are simulated; no data leaves your machine.

Add a model to make the front desk and triage smarter (the demo works without one, on rules):

```bash
KEEL_MODEL_PROVIDER=anthropic KEEL_MODEL_API_KEY=sk-ant-... keel demo
```

### 2. Point it at a real repo: `keel checkup`

```bash
keel checkup vercel/next.js            # public repos need no token
GITHUB_TOKEN=ghp_... keel checkup acme/private-repo
```

A graded report (A–F) of stale PRs, PRs waiting for review, merge time, ownerless issues, CI on the default
branch, CODEOWNERS, CONTRIBUTING and SECURITY.md. Read-only.

### 3. Run it for your teams

Pick one of the [deploy](#deploy) paths, open the URL, and the setup wizard walks you through:
**admin → model → Slack → GitHub → policy → first team**. Each step tests the connection before saving and says
in one line why it failed if it does.

## Deploy

| Path | For | Database |
| --- | --- | --- |
| `keel demo` | Trying it | SQLite (file) |
| Docker Compose | One server, a few teams | Postgres 16 (bundled) |
| Helm | Kubernetes, SSO, many teams | Your Postgres (or bundled for a trial) |

### Docker Compose

```bash
git clone https://github.com/evanl666/keel && cd keel
cp deploy/.env.example deploy/.env
docker run --rm ghcr.io/evanl666/keel secret     # paste into KEEL_SECRET_KEY; also set POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml up -d
open http://localhost:8420
```

### Helm

```bash
helm install keel deploy/helm/keel \
  --set secretKey=$(keel secret) \
  --set database.url='postgresql+psycopg://keel:PASS@db.internal:5432/keel' \
  --set baseUrl=https://keel.example.com \
  --set ingress.enabled=true --set ingress.host=keel.example.com \
  --set env.KEEL_OIDC_ISSUER=https://login.example.com --set env.KEEL_OIDC_CLIENT_ID=keel \
  --set extraSecretEnv.KEEL_OIDC_CLIENT_SECRET=...
```

The chart runs separate web and worker Deployments, migrates in an init container under a Postgres advisory
lock, uses a read-only root filesystem as uid 10001, and exposes `/healthz`, `/readyz` and `/metrics`
(Prometheus). `--set postgres.enabled=true` bundles a Postgres for trials; use a managed one in production.

### Configuration as code: `keel apply`

```yaml
# keel.yaml
org: Acme
default_level: 1
teams:
  - slug: payments
    name: Payments
    steward: {name: Pip, emoji: "🦉"}
    slack_channel: "#payments"
    github_repos: [acme/payments]
    services:
      - {name: checkout-api, url: https://checkout.acme.example/healthz}
    knowledge:
      - {path: docs/webhook-signing.md, label: internal}
```

```bash
keel apply -f keel.yaml --dry-run    # shows + create, ~ update, = keep, ! skip
keel apply -f keel.yaml              # safe to re-run; never deletes, never raises a level
```

### Runbooks without inbound access: `keel runner`

The runner lives inside your network and polls Keel over HTTPS. It only runs commands from **its own local
allow-list**; Keel sends a runbook id, never a command.

```bash
KEEL_RUNNER_TOKEN=... keel runner --server https://keel.example.com --allow runner-allow.yaml
```

### Operations

```bash
keel doctor                 # checks database, migrations, secret key, model, Slack, GitHub, web UI
keel backup -o keel.dump    # pg_dump, or the SQLite backup API
keel restore keel.dump
keel worker                 # run the worker separately (Helm does this for you)
```

## How it works

```
 Slack (Socket Mode) ─┐                        ┌─▶ Slack / GitHub / other team's steward / runner
 GitHub webhooks ─────┼─▶ inbox ─▶ steward ─▶ gateway (outbox) ──┘
 Web UI / API ────────┘       brain: triage, answer      │
                              ledger · knowledge · levels └─▶ reconcile on unknown outcome
                         Postgres: state + job queue (FOR UPDATE SKIP LOCKED). No Redis, no broker.
```

- **Every write goes through one gateway.** It records the intent first (an outbox row), checks labels,
  canaries and the steward's level, then dispatches from a job.
- **Lost responses are not retried blindly.** A timeout, a dropped connection after sending, or a 5xx/gateway
  error means *unknown outcome*: Keel looks for the write by its operation id before sending again. If the
  target can't be checked, the operation waits for a person (`needs_review`). A crash between the remote write
  and the local ack leaves a `dispatching` row whose lease runs out; recovery treats it the same way.
- **Honest limits.** The outbox guarantees durable intent, not exactly-once delivery. There is no universal
  exactly-once for posts, commands, model calls or token spend. A 403 is treated as "lacks access", not as an
  expired credential; only a 401 or the provider's explicit token error means reconnect.
- **Labels on everything.** Notes are public, internal, confidential or restricted. Derived text takes the
  strictest label it used. Another team's channel is cleared for internal; restricted is never sent anywhere.
  Planted canary tokens catch leaks: a hit blocks the write, pauses the steward and drops it to L1.
- **Models.** Anthropic, OpenAI, Azure OpenAI, Ollama, or the Claude Code CLI; or none (the rule-based brain).
  The front desk is a LangChain `create_agent` with a small set of ledger and knowledge tools.

## What's in v0.1, and what isn't yet

Built: the six duties, levels with promotion and demotion, the gateway with reconciliation, Slack (Socket
Mode), GitHub (token or App, webhooks), OIDC SSO with an admin group, the setup wizard, the web UI with a live
stream, `keel apply`, the runner, Compose and Helm, Prometheus metrics, audit log, backup and restore.

Not yet, on purpose:

- **Hosted cloud.** Self-host only for now.
- **Microsoft Teams.** Slack first.
- **Postgres row-level security.** Tenancy is enforced in the application layer; one org per install.
- **Vector search.** Knowledge uses BM25, which is enough for team-sized notes. pgvector later.
- **Multi-org per install.** The schema is ready; the UI isn't.

## Develop

```bash
uv sync --extra dev --extra all
uv run pytest                                              # unit, API and gateway tests on SQLite
KEEL_TEST_DATABASE_URL=postgresql+psycopg://... uv run pytest -m postgres
KEEL_LIVE_PROVIDER=claude_code uv run pytest -m live      # real model calls
cd web && npm ci && npm run dev                            # UI on :5173, proxies /api to :8420
```

License: Apache-2.0.

---

<a id="中文"></a>
## 中文

**给每个团队一个 AI 管家。** Keel 为每个团队配一个管家：把团队的承诺记在账上、在“前台”回答问题、
每天发简报、盯着团队的服务、在团队之间传递请求。它能做什么，由团队给它的信任等级决定。

### 管家的六项职责

- **承诺账本**：Slack 里一句“周五前谁能把 webhook 密钥轮换一下？”会变成 **C-88**，有负责人、截止日期和风险灯；之后一句“C-88 做完了”就会关闭它。
- **前台问答**：任何人都可以问管家，答案来自团队文档并附来源；受限内容不会被引用，回复会说明有几条被略去。
- **节奏**：每个团队每天一份简报：到期的、延期的、卡住的。
- **服务**：对团队服务做健康检查；故障自动开紧急承诺，恢复后自动关闭；L4 可执行白名单内的 runbook。
- **跨团队**：Platform 的管家可以向 Payments 的管家提需求，落到对方账本，双向关联。
- **杂务**：仓库体检（陈旧 PR、等待评审、CI 失败）和提醒。

### 信任等级：靠表现挣来，不靠配置

L0 观察 → L1 起草（每条都要人批）→ L2 协助（可在本团队频道发言）→ L3 行动（可建 issue、评论、找其他团队）
→ L4 运维（可通过出站 runner 执行白名单 runbook）。30 天内 50 次样本、≥95% 原样通过，且有人签字，才升一级；
一天内 3 次失败或被拒会自动降一级。YAML 文件只能降级，不能升级。

### 快速开始

```bash
pipx install keel-steward
keel demo                       # 浏览器里打开一个三团队的示例公司，无需任何密钥
keel checkup vercel/next.js     # 给真实仓库做体检，只读
```

正式使用：Docker Compose（单机，自带 Postgres）或 Helm（Kubernetes、SSO、多团队）。打开网址后，
设置向导依次引导：**管理员 → 模型 → Slack → GitHub → 策略 → 第一个团队**；每一步先测试连接再保存，
失败时用一句话说明原因。配置即代码用 `keel apply -f keel.yaml`；内网 runbook 用 `keel runner`
（只执行它本地白名单里的命令，服务器只发 runbook id，从不下发命令）。

### 可靠性说明（如实）

- 所有写操作都经过同一个网关：先落库记录意图（outbox），再检查标签、金丝雀和等级，最后由任务分发。
- 超时、发送后断连、5xx/网关错误都算**结果未知**：先按操作 ID 去对方系统核对，再决定是否重发；无法核对的
  非幂等写入暂停，等人确认。进程在“远端已成功、本地未确认”之间崩溃，同样走核对流程（有测试覆盖）。
- outbox 保证的是意图不丢，不是恰好一次；发消息、执行命令、模型调用、token 消耗都没有通用的恰好一次。
- 403 只表示“没有权限”，不代表凭证过期；只有 401 或平台明确的 token 错误才提示重新连接。

### v0.1 暂不包含

云托管、Microsoft Teams、Postgres 行级安全（目前在应用层隔离，每个安装一个组织）、向量检索（目前 BM25）、
单实例多组织界面。

许可证：Apache-2.0。
