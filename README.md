# ⚓ Keel

**One AI steward for every team.** Keel gives each team a steward that keeps its promises on the books, answers
the front desk, runs the daily rhythm, watches its services and carries requests between teams, and only does
what the team has trusted it to do.

[中文说明](#中文) · [Try it](#three-things-to-try-in-a-minute) · [Quickstart](#quickstart) · [How it works](#how-it-works) · [Deploy](#deploy) · [API](docs/api.md)

![Overview: three teams, their stewards, cross-team requests and live activity](docs/screenshots/overview.png)

```bash
git clone https://github.com/evanl666/keel && cd keel
(cd web && npm ci && npm run build)   # builds the UI into src/keel/web_dist
uv tool install .                     # or: pipx install .
keel demo                             # a live company of three teams in your browser, no keys needed
```

> v0.1 isn't on PyPI or GHCR yet, so install from source as above. Once published, this becomes
> `pipx install keel-steward` and the release wheel carries the built UI.

## Three things to try in a minute

**"I'll send a PR by Friday."** Somebody wrote that on your repo last month. Did they?

```bash
keel promises langchain-ai/deepagents --badge promises.svg --card card.svg
```

Keel reads a repo's recent comments, finds the promises ("I'll fix this", "working on it", "PR coming"), and
checks each one against what happened next: kept, overdue, gone quiet, dropped, or pushed to a follow-up.
Rules find candidates; a model, if you set one (`--provider`), throws out the false alarms and writes the
titles. You get a table, a README badge and a share card. Real run, 30 days of `langchain-ai/deepagents`:

![Promise check card: 44% of 13 promises kept](docs/screenshots/promise-card.png)

The card never names anyone; the table links each promise so maintainers can follow up kindly. For a
private repo the card leaves the comment text out too.

To keep a badge in your README, copy [`examples/workflows/promise-check.yml`](examples/workflows/promise-check.yml)
into `.github/workflows/`. Every Monday it rescans and commits `.github/badges/promises.svg`; add
`![promises kept](.github/badges/promises.svg)` to the README once. The badge is a file in your repo, so
nothing points back at a Keel server and nobody needs to sign in to see it.

**Team Wrapped.** Spotify Wrapped for a team's promises: on-time rate, longest streak, fastest close, best
partner team, and a persona (The Closers, The Good Neighbours, The Speedrunners…).

```bash
keel wrapped payments --card wrapped.svg       # also at /api/teams/payments/wrapped/card.svg
```

![Team Wrapped card for Payments](docs/screenshots/wrapped-card.png)

**Your steward inside your editor.** `keel mcp` is an MCP server, so Claude Code, Cursor or any MCP client can
ask a team's steward, see what's overdue, and log a promise without leaving the editor.

```bash
claude mcp add keel -- keel mcp --as you@acme.example          # Claude Code
```

```json
{ "mcpServers": { "keel": { "command": "keel", "args": ["mcp", "--as", "you@acme.example"] } } }
```

Tools: `list_teams`, `ask_team`, `list_commitments`, `log_commitment`, `update_commitment`, `team_wrapped`,
`find_promises`. Without `--as` it's read-only. Answers respect labels: restricted notes never leave Keel.

Badges for any checkup too: `keel checkup owner/repo --badge .github/badges/checkup.svg`, or **Download
badge** on the Checkup page. Commit the file and link it from the README the same way. (The
`/api/checkups/{id}/badge.svg` route needs a signed-in user, so it's for the app, not for a README.)

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
| **Learning** | Edits, rejections, ledger fixes and thread answers become lessons and knowledge. See below. |

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

### It learns from the team

A steward that makes the same mistake twice isn't much of a colleague. Every correction is kept as a
**lesson**, and the closest few are added the next time a similar message comes in:

| You do this | It learns |
| --- | --- |
| Edit a draft before approving | **Reply lesson**: what it wrote, what you sent instead. Next time it writes it your way. |
| Reject with a reason ("Not work", "Wrong team", "Too long"…) | **Lesson** with your reason. "Not work" means similar chatter stops becoming commitments. |
| Drop or fix a commitment it logged (within 48 h) | **Triage lesson**: "lol I'll fix the coffee machine by Friday" isn't work; "by EOW" means Friday. |
| `/keel teach Reply in the language the question was asked in.` | **Rule**, used in every reply and triage. |
| Ask it something the notes don't cover | **Open question**. When a teammate answers in the Slack thread, Keel offers the answer: one click saves it to knowledge, and the next person gets it from the steward. |

Every lesson shows who taught it, how often it's been used, and a switch to turn it off. The weekly brief
says what the steward learned and which questions are still open; the Learning tab tracks how many drafts
now go out unedited. Lessons respect labels like knowledge does. Rules shape replies when a model is
connected; without one, triage lessons still apply. Nothing is fine-tuned and nothing leaves your
database.

![Learning tab: lessons, open questions, and drafts sent without edits](docs/screenshots/learning.png)

| Front desk: answers with sources | Approvals: exactly what will be sent |
| --- | --- |
| ![Front desk](docs/screenshots/front-desk.png) | ![Approvals](docs/screenshots/approvals.png) |
| **Levels: earned from approvals** | **Checkup: a graded repo report** |
| ![Level](docs/screenshots/level.png) | ![Checkup](docs/screenshots/checkup.png) |

## Quickstart

### 1. Try it: `keel demo` (2 minutes, nothing to configure)

```bash
keel demo            # --fresh starts the story over, --port changes the port (default 8420)
```

You get a seeded company (Acme: Payments 🦉 Pip, Platform 🦫 Bolt, Mobile 🐙 Echo) on SQLite in `~/.keel/demo.db`,
signed in as the demo admin. Press **Play next event** to step through nine scripted moments: a request turns into a commitment, a draft waits for
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
docker build -t ghcr.io/evanl666/keel:latest .           # until the image is published
docker run --rm ghcr.io/evanl666/keel:latest secret      # paste into KEEL_SECRET_KEY; also set POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
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

Built: the six duties, learning from corrections and open questions, levels with promotion and demotion, the gateway with reconciliation, Slack (Socket
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
uv sync --extra all
uv run pytest                                              # unit, API and gateway tests on SQLite
KEEL_TEST_DATABASE_URL=postgresql+psycopg://... uv run pytest -m postgres
KEEL_LIVE_PROVIDER=claude_code GITHUB_TOKEN=$(gh auth token) uv run pytest -m live   # real model calls
(cd web && npm ci && npm run dev)                          # UI on :5173, proxies /api to :8420
(cd web && npm run dev:mock)                                # UI on mock data, no backend
keel demo --port 8431 --fresh & node web/scripts/e2e-real.mjs /tmp/shots   # every page on the real backend
```

License: Apache-2.0.

---

<a id="中文"></a>
## 中文

**给每个团队一个 AI 管家。** Keel 为每个团队配一个管家：把团队的承诺记在账上、在“前台”回答问题、
每天发简报、盯着团队的服务、在团队之间传递请求。它能做什么，由团队给它的信任等级决定。

### 管家的职责

- **承诺账本**：Slack 里一句“周五前谁能把 webhook 密钥轮换一下？”会变成 **C-88**，有负责人、截止日期和风险灯；之后一句“C-88 做完了”就会关闭它。
- **前台问答**：任何人都可以问管家，答案来自团队文档并附来源；受限内容不会被引用，回复会说明有几条被略去。
- **节奏**：每个团队每天一份简报：到期的、延期的、卡住的。
- **服务**：对团队服务做健康检查；故障自动开紧急承诺，恢复后自动关闭；L4 可执行白名单内的 runbook。
- **跨团队**：Platform 的管家可以向 Payments 的管家提需求，落到对方账本，双向关联。
- **杂务**：仓库体检（陈旧 PR、等待评审、CI 失败）和提醒。
- **学习**：草稿修改、带理由的拒绝、账本纠正、线程里的回答，都会变成经验和知识（见下文）。

### 会向团队学习

每次纠正都会存成一条**经验（lesson）**，下次遇到相似的消息时，最相近的几条会一起交给管家：

- **改了草稿再批准**：记下“它原来写的 → 你实际发的”，下次按你的写法。
- **拒绝并写理由**（不是工作、找错团队、太长、语气不对……）：理由存成经验；“不是工作”会让类似闲聊不再被记成承诺。
- **48 小时内删掉或改正它记的承诺**：存成分拣经验，比如“周五前我把咖啡机修好 lol”不是工作，“EOW”指周五。
- **`/keel teach 用提问的语言回复。`**：存成规则，每次回复和分拣都会用到。
- **问了文档里没有的问题**：记为**待解答问题**；同事在 Slack 线程里回答后，Keel 会建议把答案存进知识库，一键保存，下一个人再问就能直接答。

每条经验都写明谁教的、用过几次，并可单独关闭。周报会列出本周学到了什么、还有哪些问题没人回答；Learning
页显示草稿原样发出的比例变化。经验和知识一样受标签控制。规则在接入模型后才影响回复；不接模型时分拣经验仍然生效。
不做微调，数据不出你的数据库。

### 信任等级：靠表现挣来，不靠配置

L0 观察 → L1 起草（每条都要人批）→ L2 协助（可在本团队频道发言）→ L3 行动（可建 issue、评论、找其他团队）
→ L4 运维（可通过出站 runner 执行白名单 runbook）。30 天内 50 次样本、≥95% 原样通过，且有人签字，才升一级；
一天内 3 次失败或被拒会自动降一级。YAML 文件只能降级，不能升级。

### 快速开始

```bash
git clone https://github.com/evanl666/keel && cd keel
(cd web && npm ci && npm run build) && uv tool install .   # v0.1 尚未发布到 PyPI，先从源码安装
keel demo                       # 浏览器里打开一个三团队的示例公司，无需任何密钥
keel checkup vercel/next.js     # 给真实仓库做体检，只读
```

正式使用：Docker Compose（单机，自带 Postgres）或 Helm（Kubernetes、SSO、多团队）。打开网址后，
设置向导依次引导：**管理员 → 模型 → Slack → GitHub → 策略 → 第一个团队**；每一步先测试连接再保存，
失败时用一句话说明原因。配置即代码用 `keel apply -f keel.yaml`；内网 runbook 用 `keel runner`
（只执行它本地白名单里的命令，服务器只发 runbook id，从不下发命令）。

### 一分钟能玩的三件事

- **承诺考古 `keel promises owner/repo`**：上个月有人在你的仓库里写了“周五前我提个 PR”，他做到了吗？Keel 读取近期评论，
  找出承诺（“我来修”“在做了”“PR 马上来”），再看后来发生了什么：兑现、逾期、没下文、放弃、挪到后续 PR。规则先找候选，
  配了模型（`--provider`）就由模型剔除误报并写标题。输出表格、README 徽章和分享卡片；卡片上不点名任何人，私有仓库的卡片也不含评论原文。
  README 徽章：把 `examples/workflows/promise-check.yml` 放进 `.github/workflows/`，每周一自动提交
  `.github/badges/promises.svg`，README 里引用这个文件即可，不依赖 Keel 服务器、无需登录。
- **团队年终总结 Team Wrapped `keel wrapped <team>`**：团队一个月的承诺回顾：按时率、最长连胜、最快关闭、最佳搭档团队，
  外加一个人设（The Closers、The Good Neighbours、The Speedrunners……）。
- **编辑器里的管家 `keel mcp`**：MCP 服务器，Claude Code、Cursor 等可直接问团队管家、看逾期、记承诺。
  不加 `--as` 时只读；受限内容永远不出 Keel。

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
