# Keel REST API (v0.1)

All endpoints live under `/api`, take and return JSON, and use a session cookie
(`keel_session`). Times are ISO-8601 UTC strings. Errors return
`{"detail": "<one plain sentence saying why>"}` with a 4xx/5xx status.

In demo mode (`keel demo`) the server auto-signs in a demo admin, so the UI
never shows a login screen there.

## Types (TypeScript)

```ts
type Level = 0 | 1 | 2 | 3 | 4;           // L0 observe … L4 runbooks
type Label = "public" | "internal" | "confidential" | "restricted";
type Role = "org_admin" | "team_admin" | "member";

interface User { id: string; name: string; email: string; role: Role; avatar_url: string | null; }
interface Me {
  user: User | null;               // null = not signed in
  org: { id: string; name: string } | null;
  demo: boolean;                    // true when running `keel demo`
  setup_complete: boolean;          // false → UI routes to /setup
  sso_enabled: boolean;             // show "Sign in with SSO"
  version: string;
}

interface StewardSummary {
  id: string;
  name: string;                     // e.g. "Pip"
  emoji: string;                    // e.g. "🦉" — avatar glyph
  level: Level;
  level_name: string;               // "Observe" | "Draft" | "Assist" | "Act" | "Operate"
  paused: boolean;
  status_line: string;              // one calm line: "Watching 3 channels. 2 drafts wait for you."
  duties: Duty[];
}
type Duty = "ledger" | "front_desk" | "rhythm" | "services" | "knowledge" | "chores";

interface TeamSummary {
  id: string; slug: string; name: string; color: string;   // hex, team accent
  steward: StewardSummary;
  health: number;                   // 0..100 team health score
  counts: { open: number; at_risk: number; overdue: number; pending_approvals: number;
            incidents_open: number; requests_in: number; requests_out: number; };
}

interface Overview {
  org: { id: string; name: string };
  teams: TeamSummary[];
  cross_team: CrossTeamEdge[];      // for a team graph
  totals: { open: number; done_7d: number; at_risk: number; overdue: number;
            pending_approvals: number; incidents_open: number; ops_needs_review: number; };
  activity: ActivityItem[];         // latest 30, newest first
}
interface CrossTeamEdge { from_team: string; to_team: string; open: number; at_risk: number; } // slugs

interface ActivityItem {
  id: string; at: string; team_slug: string | null;
  kind: "commitment" | "approval" | "operation" | "service" | "brief" | "knowledge" | "level" | "inbox" | "chat";
  icon: string;                     // emoji
  text: string;                     // one plain line: "Pip logged C-88 for Payments: rotate webhook secret"
  link: string | null;              // UI route, e.g. "/commitments/C-88"
}

type CommitmentStatus = "proposed" | "accepted" | "in_progress" | "blocked" | "done" | "dropped" | "declined";
type Risk = "on_track" | "at_risk" | "overdue" | "none";
interface Commitment {
  key: string;                      // "C-88"
  title: string; detail: string;
  status: CommitmentStatus; risk: Risk; priority: "low" | "normal" | "high" | "urgent";
  owner_team: string;               // slug
  requester_team: string | null;    // slug, when it came from another team
  owner_person: string | null;      // display name
  requester_person: string | null;
  due_at: string | null; created_at: string; updated_at: string;
  source_url: string | null;        // Slack permalink / GitHub URL
  source_kind: "slack" | "github" | "web" | "steward" | "service" | "demo";
  label: Label;
}
interface CommitmentEvent { id: string; at: string; actor: string; kind: string; text: string; }
interface CommitmentDetail extends Commitment { events: CommitmentEvent[]; operations: Operation[]; }

type OpStatus = "awaiting_approval" | "intent_recorded" | "dispatching" | "acked" | "unknown"
              | "reconciled" | "needs_review" | "done" | "failed" | "rejected";
interface Operation {
  id: string; op_id: string;        // op_id e.g. "c-88:create-issue"
  team_slug: string; kind: string;  // "slack.post" | "github.create_issue" | "github.comment" | "runbook.run" | ...
  target: string;                   // "#payments" / "acme/api" / "svc:checkout:restart"
  summary: string;                  // one line
  status: OpStatus; attempts: number;
  error_class: string | null;       // "unknown_outcome" | "auth_invalid" | "permission_denied" | "not_found" | "rate_limited" | "bad_request" | null
  error_line: string | null;        // one plain line saying why
  remote_ref: string | null;        // URL or id of what was created
  created_at: string; updated_at: string;
}

interface Approval {
  id: string; team_slug: string; created_at: string;
  kind: string;                     // same as Operation.kind
  title: string;                    // "Post to #payments"
  preview: string;                  // the exact text/payload to be sent (markdown)
  reason: string;                   // why it needs you: "Pip is at L1 Draft: posts need approval."
  label: Label; audience: string;   // "#payments (14 people)"
  commitment_key: string | null;
  status: "pending" | "approved" | "rejected";
}

interface LevelInfo {
  level: Level; level_name: string;
  levels: { level: Level; name: string; can: string }[];        // all 5 with one-line "can"
  samples: number; approval_rate: number | null;                // last window
  min_samples: number; min_approval_rate: number;
  eligible_for: Level | null;       // promotion suggested
  history: { at: string; from: Level; to: Level; reason: string; actor: string }[];
}

interface KnowledgeDoc { id: string; title: string; source: string; label: Label; updated_at: string; snippet: string; chars: number; }
interface AskResult { answer: string; label: Label; sources: { title: string; source: string; label: Label }[]; withheld: number; } // withheld = sources hidden because the audience can't see them

interface ServiceCheck { at: string; ok: boolean; latency_ms: number | null; status_code: number | null; }
interface Service {
  id: string; name: string; url: string; owner: string | null;
  state: "up" | "degraded" | "down" | "unknown";
  uptime_24h: number | null;        // 0..1
  latency_p50_ms: number | null;
  checks: ServiceCheck[];           // last 60, oldest first (sparkline)
  open_incident: { id: string; opened_at: string; summary: string; commitment_key: string | null } | null;
  runbooks: { id: string; name: string; min_level: Level }[];
}

interface Brief { id: string; team_slug: string; kind: "daily" | "weekly" | "checkup"; created_at: string; title: string; markdown: string; }

interface AuditEntry { id: string; at: string; actor: string; action: string; target: string; detail: string; team_slug: string | null; }

interface ChatMessage { role: "user" | "steward"; text: string; at: string; sources?: AskResult["sources"]; actions?: { kind: string; text: string; link: string | null }[]; }

interface SetupStep { id: "admin" | "model" | "slack" | "github" | "policy" | "team"; title: string; done: boolean; optional: boolean; detail: string; }

interface CheckupReport {
  id: string; repo: string; status: "running" | "done" | "failed"; error_line: string | null;
  score: number | null;             // 0..100
  grade: string | null;             // "A".."F"
  findings: { severity: "high" | "medium" | "low"; title: string; detail: string; url: string | null }[];
  stats: Record<string, number | string>;
  created_at: string;
}
```

## Endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/me | | Me |
| POST | /api/auth/login | {email, password} | Me |
| POST | /api/auth/logout | | {ok} |
| GET | /api/auth/sso | | 302 to the IdP |
| GET | /api/setup | | {steps: SetupStep[], slack_manifest_url: string} |
| POST | /api/setup/{step} | step-specific JSON (see below) | {ok, message} |
| POST | /api/setup/{step}/test | same JSON | {ok, message} — message is one plain line |
| GET | /api/setup/slack-manifest | | YAML file |
| GET | /api/overview | | Overview |
| GET | /api/teams | | TeamSummary[] |
| POST | /api/teams | {name, slug?, steward_name?, emoji?, color?} | TeamSummary |
| GET | /api/teams/{slug} | | TeamSummary & {today: Brief \| null, activity: ActivityItem[]} |
| PATCH | /api/teams/{slug}/steward | {paused?, name?, emoji?, duties?} | StewardSummary |
| GET | /api/teams/{slug}/level | | LevelInfo |
| POST | /api/teams/{slug}/level | {level, reason} | LevelInfo |
| GET | /api/commitments?team=&status=&risk= | | Commitment[] |
| POST | /api/commitments | {team, title, detail?, due_at?, owner_person?, priority?, requester_team?} | Commitment |
| GET | /api/commitments/{key} | | CommitmentDetail |
| PATCH | /api/commitments/{key} | {status?, due_at?, owner_person?, priority?, note?} | CommitmentDetail |
| GET | /api/approvals?team=&status=pending | | Approval[] |
| POST | /api/approvals/{id}/approve | {edited_preview?} | Approval |
| POST | /api/approvals/{id}/reject | {reason?} | Approval |
| GET | /api/operations?team=&status= | | Operation[] |
| POST | /api/operations/{id}/resolve | {outcome: "done" \| "retry" \| "cancel"} | Operation |
| GET | /api/teams/{slug}/knowledge | | KnowledgeDoc[] |
| POST | /api/teams/{slug}/knowledge | {title, content, label, source?} | KnowledgeDoc |
| POST | /api/teams/{slug}/ask | {question} | AskResult |
| GET | /api/teams/{slug}/services | | Service[] |
| POST | /api/teams/{slug}/services | {name, url, owner?} | Service |
| POST | /api/services/{id}/runbooks/{rid}/run | | Operation |
| GET | /api/teams/{slug}/briefs | | Brief[] |
| POST | /api/teams/{slug}/briefs | {kind: "daily" \| "weekly"} | Brief |
| GET | /api/teams/{slug}/chat | | ChatMessage[] |
| POST | /api/teams/{slug}/chat | {message} | ChatMessage[] (the new steward replies) |
| GET | /api/audit?team= | | AuditEntry[] |
| POST | /api/checkups | {repo: "owner/name"} | CheckupReport (status running) |
| GET | /api/checkups/{id} | | CheckupReport |
| GET | /api/checkups | | CheckupReport[] |
| POST | /api/demo/tick | | {event: ActivityItem \| null} — demo only: plays the next scripted event |
| GET | /api/stream | | text/event-stream; each `data:` line is an ActivityItem JSON |
| GET | /healthz, /readyz, /metrics | | probes and Prometheus metrics (no /api prefix) |

Setup step bodies:
- admin: {name, email, password, org_name}
- model: {provider: "anthropic" | "openai" | "azure_openai" | "ollama" | "claude_code" | "replay", model, api_key?, base_url?}
- slack: {bot_token, app_token, signing_secret?}
- github: {token} or {app_id, private_key, installation_id}
- policy: {default_level, label_default}
- team: {name, steward_name, emoji, slack_channel?, github_repo?}

`GET /api/setup` and `POST /api/setup/*` work without sign-in only until the
admin step is done; afterwards they need an org admin.
