// Synthetic demo data for the "Acme" workspace. Nothing here leaves the browser.
import type {
  ActivityItem,
  Approval,
  AuditEntry,
  Brief,
  ChatMessage,
  CheckupReport,
  Commitment,
  CommitmentEvent,
  Duty,
  KnowledgeDoc,
  Level,
  LevelInfo,
  Operation,
  Service,
  ServiceCheck,
  SetupStep,
  TeamSummary,
} from "../types";

export const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
export const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
export const ago = (ms: number) => iso(-ms);
export const nowIso = () => new Date().toISOString();

function rng(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const LEVEL_NAMES = ["Observe", "Draft", "Assist", "Act", "Operate"] as const;
export const LEVEL_CAN: { level: Level; name: string; can: string }[] = [
  { level: 0, name: "Observe", can: "Reads channels and repos. Keeps the ledger. Sends nothing." },
  { level: 1, name: "Draft", can: "Drafts every message and change. You approve each one." },
  { level: 2, name: "Assist", can: "Posts in its own team's channels. Asks before writing elsewhere." },
  { level: 3, name: "Act", can: "Opens issues, comments and nudges other teams on its own." },
  { level: 4, name: "Operate", can: "Runs approved runbooks on its services, then reports back." },
];

const ALL_DUTIES: Duty[] = ["ledger", "front_desk", "rhythm", "services", "knowledge", "chores"];

export interface MockTeam extends TeamSummary {
  channel: string;
  members: number;
}

export function makeTeams(): MockTeam[] {
  return [
    {
      id: "t_payments",
      slug: "payments",
      name: "Payments",
      color: "#7C5CFF",
      channel: "#payments",
      members: 14,
      health: 0,
      steward: {
        id: "s_pip",
        name: "Pip",
        emoji: "🦉",
        level: 2,
        level_name: "Assist",
        paused: false,
        status_line: "",
        duties: ["ledger", "front_desk", "rhythm", "services", "knowledge"],
      },
      counts: { open: 0, at_risk: 0, overdue: 0, pending_approvals: 0, incidents_open: 0, requests_in: 0, requests_out: 0 },
    },
    {
      id: "t_platform",
      slug: "platform",
      name: "Platform",
      color: "#10B981",
      channel: "#platform",
      members: 23,
      health: 0,
      steward: {
        id: "s_bolt",
        name: "Bolt",
        emoji: "🦫",
        level: 3,
        level_name: "Act",
        paused: false,
        status_line: "",
        duties: [...ALL_DUTIES],
      },
      counts: { open: 0, at_risk: 0, overdue: 0, pending_approvals: 0, incidents_open: 0, requests_in: 0, requests_out: 0 },
    },
    {
      id: "t_mobile",
      slug: "mobile",
      name: "Mobile",
      color: "#F59E0B",
      channel: "#mobile",
      members: 11,
      health: 0,
      steward: {
        id: "s_echo",
        name: "Echo",
        emoji: "🐙",
        level: 1,
        level_name: "Draft",
        paused: false,
        status_line: "",
        duties: ["ledger", "front_desk", "rhythm", "knowledge"],
      },
      counts: { open: 0, at_risk: 0, overdue: 0, pending_approvals: 0, incidents_open: 0, requests_in: 0, requests_out: 0 },
    },
  ];
}

type C = Omit<Commitment, "created_at" | "updated_at" | "source_url" | "label" | "requester_person" | "detail"> &
  Partial<Pick<Commitment, "source_url" | "label" | "requester_person" | "detail">> & { created: number; updated?: number };

const raw: C[] = [
  { key: "C-81", title: "Ship refund idempotency keys", status: "in_progress", risk: "on_track", priority: "high", owner_team: "payments", requester_team: null, owner_person: "Maya Chen", due_at: iso(3 * DAY), source_kind: "github", source_url: "https://github.com/acme/payments-api/issues/412", created: 9 * DAY, detail: "Refund requests retried by the gateway must not double-refund. Add an Idempotency-Key header and a 24h dedupe table." },
  { key: "C-82", title: "Publish Q4 PCI evidence pack", status: "accepted", risk: "on_track", priority: "normal", owner_team: "payments", requester_team: null, owner_person: "Priya Nair", due_at: iso(9 * DAY), source_kind: "slack", label: "confidential", created: 6 * DAY, detail: "Collect access reviews, key rotation logs and change tickets for the auditor." },
  { key: "C-83", title: "Upgrade ledger-db from Postgres 15 to 16", status: "in_progress", risk: "at_risk", priority: "high", owner_team: "platform", requester_team: "payments", owner_person: "Sam Okafor", requester_person: "Maya Chen", due_at: iso(1 * DAY + 4 * HOUR), source_kind: "slack", created: 12 * DAY, detail: "Payments needs logical replication slots from PG16 before the payout scheduler migration. Replica rebuild is slower than planned." },
  { key: "C-84", title: "Add p99 latency alerts for api-gateway", status: "done", risk: "none", priority: "normal", owner_team: "platform", requester_team: null, owner_person: "Lena Fischer", due_at: ago(1 * DAY), source_kind: "github", created: 8 * DAY, updated: 1 * DAY },
  { key: "C-85", title: "Fix crash on Android 15 checkout sheet", status: "in_progress", risk: "overdue", priority: "urgent", owner_team: "mobile", requester_team: "payments", owner_person: "Kenji Watanabe", requester_person: "Diego Ramos", due_at: ago(3 * DAY), source_kind: "github", source_url: "https://github.com/acme/mobile-app/issues/1893", created: 10 * DAY, detail: "2.1% of Android 15 sessions crash when the payment sheet opens over a dialog. Payments sees abandoned checkouts." },
  { key: "C-86", title: "Ship dark mode to settings screens", status: "accepted", risk: "on_track", priority: "low", owner_team: "mobile", requester_team: null, owner_person: "Ana Lima", due_at: iso(12 * DAY), source_kind: "slack", created: 4 * DAY },
  { key: "C-87", title: "Answer Mobile's question on 3DS fallback", status: "done", risk: "none", priority: "normal", owner_team: "payments", requester_team: "mobile", owner_person: "Pip", requester_person: "Ana Lima", due_at: ago(2 * DAY), source_kind: "steward", created: 3 * DAY, updated: 2 * DAY, label: "public" },
  { key: "C-88", title: "Rotate webhook signing secret", status: "in_progress", risk: "at_risk", priority: "high", owner_team: "payments", requester_team: "platform", owner_person: "Diego Ramos", requester_person: "Sam Okafor", due_at: iso(20 * HOUR), source_kind: "slack", source_url: "https://acme.slack.com/archives/C02PLAT/p1732650000", created: 5 * DAY, label: "confidential", detail: "Platform found the webhook signing secret in an old CI log. Rotate it, give partners the overlap window, and confirm in #platform." },
  { key: "C-89", title: "Provision staging env for Mobile release train", status: "proposed", risk: "none", priority: "normal", owner_team: "platform", requester_team: "mobile", owner_person: null, requester_person: "Kenji Watanabe", due_at: iso(5 * DAY), source_kind: "steward", created: 1 * DAY },
  { key: "C-90", title: "Migrate payout cron to scheduler v2", status: "blocked", risk: "at_risk", priority: "high", owner_team: "payments", requester_team: null, owner_person: "Maya Chen", due_at: iso(2 * DAY), source_kind: "github", created: 14 * DAY, detail: "Blocked on C-83: scheduler v2 needs PG16 logical replication." },
  { key: "C-91", title: "Rotate CI runner tokens", status: "in_progress", risk: "overdue", priority: "high", owner_team: "platform", requester_team: null, owner_person: "Lena Fischer", due_at: ago(1 * DAY + 2 * HOUR), source_kind: "service", created: 7 * DAY, label: "restricted" },
  { key: "C-92", title: "Add payment sheet analytics events", status: "proposed", risk: "none", priority: "low", owner_team: "mobile", requester_team: "payments", owner_person: null, requester_person: "Priya Nair", due_at: null, source_kind: "slack", created: 20 * HOUR },
  { key: "C-93", title: "Write incident review for checkout-api 503s", status: "accepted", risk: "on_track", priority: "high", owner_team: "payments", requester_team: null, owner_person: "Diego Ramos", due_at: iso(2 * DAY + 6 * HOUR), source_kind: "service", created: 2 * HOUR },
  { key: "C-94", title: "Bump React Native to 0.79", status: "dropped", risk: "none", priority: "normal", owner_team: "mobile", requester_team: null, owner_person: "Kenji Watanabe", due_at: null, source_kind: "github", created: 21 * DAY, updated: 6 * DAY },
  { key: "C-95", title: "Give Payments write access to prod Kafka", status: "declined", risk: "none", priority: "normal", owner_team: "platform", requester_team: "payments", owner_person: "Sam Okafor", requester_person: "Maya Chen", due_at: null, source_kind: "slack", created: 11 * DAY, updated: 9 * DAY, detail: "Declined: Platform offered a scoped producer through the event gateway instead." },
];

export function makeCommitments(): Commitment[] {
  return raw.map((c) => {
    const { created, updated, ...rest } = c;
    return {
      detail: "",
      source_url: null,
      label: "internal",
      requester_person: null,
      ...rest,
      created_at: ago(created),
      updated_at: ago(updated ?? Math.min(created, 3 * HOUR + (created % 7) * HOUR)),
    };
  });
}

export function makeEvents(): Record<string, CommitmentEvent[]> {
  const ev: Record<string, CommitmentEvent[]> = {};
  const mk = (key: string, list: [number, string, string, string][]) => {
    ev[key] = list.map(([t, actor, kind, text], i) => ({ id: `${key}-e${i}`, at: ago(t), actor, kind, text }));
  };
  mk("C-88", [
    [5 * DAY, "Sam Okafor", "message", "Asked in #platform: \"Can Payments rotate the webhook signing secret this week? It showed up in a CI log.\""],
    [5 * DAY - 10 * MIN, "Bolt 🦫", "request", "Sent the request to Pip for Payments."],
    [5 * DAY - 12 * MIN, "Pip 🦉", "logged", "Logged C-88 for Payments. Owner: Diego Ramos."],
    [4 * DAY, "Diego Ramos", "accepted", "Accepted. Due Friday."],
    [2 * DAY, "Diego Ramos", "status", "Moved to in progress. New secret generated in Vault."],
    [6 * HOUR, "Pip 🦉", "risk", "Marked at risk: 2 of 5 partners haven't confirmed the overlap window."],
    [40 * MIN, "Pip 🦉", "draft", "Drafted an update for #platform. It waits for approval."],
  ]);
  mk("C-83", [
    [12 * DAY, "Maya Chen", "message", "Asked Platform for PG16 on ledger-db."],
    [12 * DAY - 5 * MIN, "Pip 🦉", "request", "Sent the request to Bolt for Platform."],
    [11 * DAY, "Sam Okafor", "accepted", "Accepted. Target: next Thursday."],
    [3 * DAY, "Bolt 🦫", "status", "Replica rebuild started on ledger-db-2."],
    [9 * HOUR, "Bolt 🦫", "risk", "Marked at risk: rebuild is at 61% after 3 days."],
  ]);
  mk("C-85", [
    [10 * DAY, "Diego Ramos", "message", "Filed acme/mobile-app#1893 from crash reports."],
    [10 * DAY - 3 * MIN, "Echo 🐙", "logged", "Logged C-85 for Mobile, requested by Payments."],
    [8 * DAY, "Kenji Watanabe", "accepted", "Accepted. Due in 7 days."],
    [3 * DAY, "Echo 🐙", "risk", "Due date passed. Draft nudge waits for approval."],
    [1 * DAY, "Kenji Watanabe", "note", "Root cause found: sheet attaches to a destroyed activity."],
  ]);
  mk("C-91", [
    [7 * DAY, "Bolt 🦫", "logged", "Logged C-91 from the token expiry check on ci-runners."],
    [3 * DAY, "Lena Fischer", "status", "In progress. 14 of 22 runners rotated."],
    [1 * DAY, "Bolt 🦫", "operation", "Tried to open a tracking issue in acme/infra. GitHub returned 503."],
  ]);
  mk("C-90", [
    [14 * DAY, "Maya Chen", "logged", "Opened from acme/payments-api#398."],
    [4 * DAY, "Pip 🦉", "blocked", "Marked blocked on C-83 (Platform)."],
  ]);
  return ev;
}

let opSeq = 0;
function op(p: Partial<Operation> & Pick<Operation, "op_id" | "team_slug" | "kind" | "target" | "summary" | "status">, created: number): Operation {
  opSeq += 1;
  return {
    id: `op_${String(opSeq).padStart(3, "0")}`,
    attempts: 1,
    error_class: null,
    error_line: null,
    remote_ref: null,
    created_at: ago(created),
    updated_at: ago(Math.max(0, created - 2 * MIN)),
    ...p,
  };
}

export function makeOperations(): Operation[] {
  opSeq = 0;
  return [
    op({ op_id: "c-91:create-issue", team_slug: "platform", kind: "github.create_issue", target: "acme/infra", summary: "Open tracking issue for CI runner token rotation", status: "needs_review", error_class: "unknown_outcome", error_line: "GitHub returned 503 after the request was sent, so the issue may exist. Check before retrying." }, 1 * DAY),
    op({ op_id: "c-85:nudge-1", team_slug: "mobile", kind: "slack.post", target: "#mobile", summary: "Nudge Kenji about the overdue Android crash fix", status: "needs_review", error_class: "unknown_outcome", error_line: "Slack timed out after the message was sent, so it may already be in #mobile. Look there first." }, 3 * HOUR),
    op({ op_id: "c-88:update-platform", team_slug: "payments", kind: "slack.post", target: "#platform", summary: "Tell Platform the rotation window for the webhook secret", status: "awaiting_approval", attempts: 0 }, 40 * MIN),
    op({ op_id: "brief:mobile:daily", team_slug: "mobile", kind: "slack.post", target: "#mobile", summary: "Post today's brief", status: "awaiting_approval", attempts: 0 }, 25 * MIN),
    op({ op_id: "c-93:incident-thread", team_slug: "payments", kind: "slack.post", target: "#payments-incidents", summary: "Open incident thread for checkout-api 503s", status: "done", remote_ref: "https://acme.slack.com/archives/C04INC/p1732663000" }, 2 * HOUR),
    op({ op_id: "c-83:comment-progress", team_slug: "platform", kind: "github.comment", target: "acme/infra#771", summary: "Post replica rebuild progress", status: "acked", remote_ref: "https://github.com/acme/infra/issues/771#issuecomment-2210" }, 9 * HOUR),
    op({ op_id: "c-89:ack-request", team_slug: "platform", kind: "slack.post", target: "#mobile", summary: "Tell Mobile the staging request was received", status: "dispatching" }, 2 * MIN),
    op({ op_id: "c-92:log-request", team_slug: "mobile", kind: "github.create_issue", target: "acme/mobile-app", summary: "Draft an issue for payment sheet analytics", status: "intent_recorded", attempts: 0 }, 6 * MIN),
    op({ op_id: "c-81:link-pr", team_slug: "payments", kind: "github.comment", target: "acme/payments-api#412", summary: "Link refund idempotency PR to the issue", status: "reconciled", remote_ref: "https://github.com/acme/payments-api/issues/412#issuecomment-1887" }, 26 * HOUR),
    op({ op_id: "kb:sync-wiki", team_slug: "platform", kind: "github.comment", target: "acme/platform-wiki#12", summary: "Note that the wiki sync finished", status: "failed", attempts: 3, error_class: "permission_denied", error_line: "GitHub says the Keel app can't write to acme/platform-wiki. An admin needs to add the repo to the app." }, 30 * HOUR),
    op({ op_id: "c-94:close-issue", team_slug: "mobile", kind: "github.comment", target: "acme/mobile-app#1702", summary: "Close the React Native bump issue", status: "rejected", attempts: 0 }, 6 * DAY),
    op({ op_id: "brief:payments:daily", team_slug: "payments", kind: "slack.post", target: "#payments", summary: "Post today's brief", status: "done", remote_ref: "https://acme.slack.com/archives/C01PAY/p1732660000" }, 5 * HOUR),
    op({ op_id: "svc:api-gateway:diagnostics", team_slug: "platform", kind: "runbook.run", target: "svc:api-gateway:collect-diagnostics", summary: "Collect diagnostics on api-gateway", status: "done", remote_ref: "run-58213" }, 20 * HOUR),
    op({ op_id: "c-90:remind-blocker", team_slug: "payments", kind: "slack.post", target: "#platform", summary: "Remind Platform that C-90 waits on C-83", status: "unknown", error_class: "unknown_outcome", error_line: "Slack didn't confirm in time. Keel is checking the channel now." }, 4 * MIN),
  ];
}

export function makeApprovals(): Approval[] {
  return [
    {
      id: "ap_1",
      team_slug: "payments",
      created_at: ago(40 * MIN),
      kind: "slack.post",
      title: "Post to #platform",
      preview:
        "Hi Platform 👋 Update on **C-88 · Rotate webhook signing secret**:\n\n- New secret is in Vault.\n- Partners get a 48h overlap starting **Thu 14:00 UTC**.\n- 3 of 5 partners confirmed. Diego is chasing the other two.\n\nWe'll confirm here when the old secret is revoked.",
      reason: "Pip is at L2 Assist: posts in another team's channel need approval.",
      label: "internal",
      audience: "#platform (23 people)",
      commitment_key: "C-88",
      status: "pending",
    },
    {
      id: "ap_2",
      team_slug: "mobile",
      created_at: ago(25 * MIN),
      kind: "slack.post",
      title: "Post today's brief to #mobile",
      preview:
        "**Mobile · Thursday brief** 🐙\n\n- 🔴 C-85 Android 15 checkout crash is 3d overdue. Kenji found the root cause.\n- 🟡 2 new requests from Payments wait for an owner.\n- ✅ Nothing else needs you today.",
      reason: "Echo is at L1 Draft: every post needs approval.",
      label: "internal",
      audience: "#mobile (11 people)",
      commitment_key: null,
      status: "pending",
    },
    {
      id: "ap_3",
      team_slug: "platform",
      created_at: ago(12 * MIN),
      kind: "runbook.run",
      title: "Run runbook: restart checkout-api canary pool",
      preview: "runbook: restart-canary\nservice: checkout-api\npool: canary (4 pods)\nstrategy: rolling, maxUnavailable=1\nexpected: ~3 min, no customer traffic on canary",
      reason: "This runbook needs L4 Operate. Bolt is at L3 Act.",
      label: "internal",
      audience: "svc:checkout-api (production)",
      commitment_key: "C-93",
      status: "pending",
    },
    {
      id: "ap_4",
      team_slug: "payments",
      created_at: ago(4 * HOUR),
      kind: "github.create_issue",
      title: "Create issue in acme/payments-api",
      preview:
        "### Payout cron migration is blocked on PG16\n\nC-90 can't start until ledger-db runs Postgres 16 (C-83, Platform).\n\n- Current ETA from Platform: tomorrow\n- Risk: payout window on the 1st\n\n_Opened by Pip for Maya Chen._",
      reason: "Labeled confidential: Pip asks before writing it somewhere new.",
      label: "confidential",
      audience: "acme/payments-api (18 people)",
      commitment_key: "C-90",
      status: "pending",
    },
  ];
}

function checks(seed: number, base: number, jitter: number, failFrom = -1, degradeFrom = -1): ServiceCheck[] {
  const r = rng(seed);
  const out: ServiceCheck[] = [];
  for (let i = 0; i < 60; i++) {
    const at = ago((59 - i) * 24 * MIN);
    const failing = failFrom >= 0 && i >= failFrom && r() < 0.8;
    const slow = degradeFrom >= 0 && i >= degradeFrom;
    const blip = !failing && r() < 0.015;
    const ok = !failing && !blip;
    const lat = ok ? Math.round(base + r() * jitter + (slow ? base * 2.2 + r() * jitter * 3 : 0) + (r() < 0.06 ? jitter * 2 : 0)) : null;
    out.push({ at, ok, latency_ms: lat, status_code: ok ? 200 : failing ? 503 : 502 });
  }
  return out;
}

function svc(s: Omit<Service, "uptime_24h" | "latency_p50_ms">): Service {
  const oks = s.checks.filter((c) => c.ok);
  const lats = oks.map((c) => c.latency_ms ?? 0).sort((a, b) => a - b);
  return { ...s, uptime_24h: oks.length / s.checks.length, latency_p50_ms: lats.length ? lats[Math.floor(lats.length / 2)] : null };
}

export function makeServices(): Record<string, Service[]> {
  return {
    payments: [
      svc({
        id: "svc_checkout",
        name: "checkout-api",
        url: "https://checkout.acme.internal/healthz",
        owner: "Diego Ramos",
        state: "down",
        checks: checks(11, 82, 30, 53),
        open_incident: { id: "inc_204", opened_at: ago(2 * HOUR + 10 * MIN), summary: "checkout-api returns 503 on 1 in 8 requests since the 18:00 deploy.", commitment_key: "C-93" },
        runbooks: [
          { id: "rb_diag", name: "Collect diagnostics", min_level: 2 },
          { id: "rb_restart", name: "Restart canary pool", min_level: 3 },
          { id: "rb_rollback", name: "Roll back last deploy", min_level: 4 },
        ],
      }),
      svc({ id: "svc_webhooks", name: "payments-webhooks", url: "https://hooks.acme.internal/healthz", owner: "Maya Chen", state: "up", checks: checks(12, 45, 18), open_incident: null, runbooks: [{ id: "rb_replay", name: "Replay failed deliveries", min_level: 3 }] }),
      svc({ id: "svc_ledger", name: "ledger-reader", url: "https://ledger.acme.internal/healthz", owner: "Priya Nair", state: "up", checks: checks(13, 31, 12), open_incident: null, runbooks: [] }),
    ],
    platform: [
      svc({ id: "svc_gateway", name: "api-gateway", url: "https://gw.acme.internal/healthz", owner: "Lena Fischer", state: "up", checks: checks(21, 24, 10), open_incident: null, runbooks: [{ id: "rb_gw_diag", name: "Collect diagnostics", min_level: 2 }, { id: "rb_gw_drain", name: "Drain a zone", min_level: 4 }] }),
      svc({ id: "svc_ci", name: "ci-runners", url: "https://ci.acme.internal/healthz", owner: "Sam Okafor", state: "degraded", checks: checks(22, 140, 60, -1, 44), open_incident: null, runbooks: [{ id: "rb_ci_scale", name: "Add 4 runners", min_level: 3 }] }),
      svc({ id: "svc_auth", name: "auth-service", url: "https://auth.acme.internal/healthz", owner: "Lena Fischer", state: "up", checks: checks(23, 38, 14), open_incident: null, runbooks: [] }),
    ],
    mobile: [
      svc({ id: "svc_bff", name: "mobile-bff", url: "https://m.acme.internal/healthz", owner: "Ana Lima", state: "up", checks: checks(31, 66, 25), open_incident: null, runbooks: [{ id: "rb_bff_flags", name: "Reload feature flags", min_level: 2 }] }),
      svc({ id: "svc_push", name: "push-service", url: "https://push.acme.internal/healthz", owner: "Kenji Watanabe", state: "up", checks: checks(32, 52, 20), open_incident: null, runbooks: [] }),
    ],
  };
}

export function makeKnowledge(): Record<string, KnowledgeDoc[]> {
  const d = (id: string, title: string, source: string, label: KnowledgeDoc["label"], upd: number, snippet: string, chars: number): KnowledgeDoc => ({
    id, title, source, label, updated_at: ago(upd), snippet, chars,
  });
  return {
    payments: [
      d("kd_1", "3DS fallback FAQ", "Notion · Payments/FAQ", "public", 3 * DAY, "When 3DS2 isn't available, we fall back to 3DS1 for cards issued before 2019, otherwise decline with code 3DS_UNAVAILABLE.", 4210),
      d("kd_2", "Refund policy runbook", "GitHub · acme/payments-docs", "internal", 6 * DAY, "Refunds over $5,000 need a second approver. Partial refunds keep the original idempotency key with a suffix.", 8932),
      d("kd_3", "Webhook secret rotation guide", "GitHub · acme/payments-docs", "confidential", 2 * DAY, "Generate the new secret in Vault, enable dual-signing for 48h, notify partners, then revoke.", 3120),
      d("kd_4", "PCI scope map", "Confluence · Security", "restricted", 12 * DAY, "Systems in cardholder data scope and the controls that cover each one.", 15402),
      d("kd_5", "On-call handbook", "Notion · Payments/On-call", "internal", 20 * DAY, "Pages go to the primary first. If no ack in 10 minutes, Pip pages the secondary and posts in #payments-incidents.", 6721),
      d("kd_6", "Partner API changelog", "Web · docs.acme.com", "public", 1 * DAY, "v2024-11: new payout.reconciled event, deprecated charge.captured_partial.", 2390),
    ],
    platform: [
      d("kd_7", "Postgres upgrade playbook", "GitHub · acme/infra", "internal", 4 * DAY, "Rebuild replicas first, then fail over during the Tuesday window. Logical slots must be recreated after cutover.", 7210),
      d("kd_8", "Request a staging env", "Notion · Platform/Self-serve", "public", 9 * DAY, "Ask in #platform or tell your steward. Envs are ready in about a day.", 1840),
      d("kd_9", "Prod access policy", "Confluence · Security", "restricted", 30 * DAY, "Who gets production write access, for how long, and who signs off.", 5120),
    ],
    mobile: [
      d("kd_10", "Release train calendar", "Notion · Mobile", "internal", 2 * DAY, "Branch cut Mondays 10:00, store submit Wednesdays, staged rollout 1% → 10% → 100%.", 2280),
      d("kd_11", "Crash triage guide", "GitHub · acme/mobile-app", "internal", 15 * DAY, "Anything above 0.5% crash-free drop pages the release captain.", 3410),
    ],
  };
}

export function makeBriefs(): Record<string, Brief[]> {
  return {
    payments: [
      {
        id: "br_p1",
        team_slug: "payments",
        kind: "daily",
        created_at: ago(5 * HOUR),
        title: "Payments · Thursday",
        markdown: `Good morning, Payments. Here is what matters today.

### Needs you
- **C-88 Rotate webhook signing secret** is *at risk*. 2 of 5 partners haven't confirmed the overlap window. Due tomorrow.
- **checkout-api** is down for 1 in 8 requests since the 18:00 deploy. Incident review is **C-93**, owned by Diego.

### Waiting on others
- **C-83** (Platform) PG16 upgrade is at risk. It blocks **C-90** payout migration.
- **C-85** (Mobile) Android 15 checkout crash is **3 days overdue**. Root cause found yesterday.

### Moving fine
- C-81 Refund idempotency keys, due in 3 days.
- C-82 PCI evidence pack, due in 9 days.

> 2 drafts wait for your approval. Nothing was sent without you.`,
      },
      {
        id: "br_p0",
        team_slug: "payments",
        kind: "weekly",
        created_at: ago(4 * DAY),
        title: "Payments · Week 47",
        markdown: `### This week
- Closed **4** commitments, opened **6**.
- Answered **11** questions from other teams. 9 from docs, 2 handed to people.

### Next week
- Payout migration depends on Platform's PG16 upgrade.`,
      },
    ],
    platform: [
      {
        id: "br_pl1",
        team_slug: "platform",
        kind: "daily",
        created_at: ago(5 * HOUR),
        title: "Platform · Thursday",
        markdown: `### Needs you
- **C-91 Rotate CI runner tokens** is 1 day overdue. 14 of 22 runners done.
- A GitHub issue for C-91 may or may not exist. Bolt couldn't tell after a 503. Check the outbox.

### Requests in
- **C-89** Mobile wants a staging env for the release train. No owner yet.
- **C-88** Payments says the webhook secret rotation starts Thursday.

### Services
- ci-runners is slow: p50 went from 140ms to 420ms in the last 6 hours.`,
      },
    ],
    mobile: [
      {
        id: "br_m1",
        team_slug: "mobile",
        kind: "daily",
        created_at: ago(30 * MIN),
        title: "Mobile · Thursday",
        markdown: `### Needs you
- 🔴 **C-85** Android 15 checkout crash is **3 days overdue**. Kenji found the root cause.
- 🟡 **C-92** Payments asked for payment sheet analytics. Nobody owns it yet.

### Quiet
- Release train cuts Monday. Nothing blocks it.`,
      },
    ],
  };
}

export function makeChat(): Record<string, ChatMessage[]> {
  return {
    payments: [
      { role: "user", text: "What's at risk this week?", at: ago(50 * MIN) },
      {
        role: "steward",
        text: "Two things.\n\n1. **C-88** Rotate webhook signing secret. 2 partners haven't confirmed. Due tomorrow.\n2. **C-90** Payout migration is blocked on Platform's PG16 upgrade (**C-83**), which is also at risk.\n\nI drafted an update for #platform. It waits for you.",
        at: ago(50 * MIN - 4000),
        actions: [
          { kind: "open", text: "Open C-88", link: "/commitments/C-88" },
          { kind: "approve", text: "Review the draft", link: "/approvals" },
        ],
      },
      { role: "user", text: "Who is on call tonight?", at: ago(20 * MIN) },
      {
        role: "steward",
        text: "Diego is primary and Priya is secondary until 09:00 tomorrow. If a page isn't acked in 10 minutes I page Priya.",
        at: ago(20 * MIN - 3000),
        sources: [{ title: "On-call handbook", source: "Notion · Payments/On-call", label: "internal" }],
      },
    ],
    platform: [
      { role: "user", text: "Anything from other teams I should look at?", at: ago(2 * HOUR) },
      { role: "steward", text: "Mobile asked for a staging env (**C-89**). It has no owner yet. Want me to suggest Sam?", at: ago(2 * HOUR - 3000), actions: [{ kind: "open", text: "Open C-89", link: "/commitments/C-89" }] },
    ],
    mobile: [],
  };
}

export function makeLevels(): Record<string, LevelInfo> {
  const base = (level: Level) => ({ level, level_name: LEVEL_NAMES[level], levels: LEVEL_CAN, min_samples: 50, min_approval_rate: 0.9 });
  return {
    payments: {
      ...base(2),
      samples: 58,
      approval_rate: 0.97,
      eligible_for: 3,
      history: [
        { at: ago(41 * DAY), from: 0, to: 1, reason: "Two weeks of clean observation.", actor: "Maya Chen" },
        { at: ago(19 * DAY), from: 1, to: 2, reason: "Approved 52 of 54 drafts unchanged.", actor: "Maya Chen" },
      ],
    },
    platform: {
      ...base(3),
      samples: 31,
      approval_rate: 0.94,
      eligible_for: null,
      history: [
        { at: ago(60 * DAY), from: 0, to: 2, reason: "Platform pilot team.", actor: "Lena Fischer" },
        { at: ago(22 * DAY), from: 2, to: 3, reason: "Ran 40 nudges with no complaints.", actor: "Lena Fischer" },
      ],
    },
    mobile: {
      ...base(1),
      samples: 18,
      approval_rate: 0.83,
      eligible_for: null,
      history: [{ at: ago(9 * DAY), from: 0, to: 1, reason: "Started drafting briefs.", actor: "Ana Lima" }],
    },
  };
}

export function makeActivity(): ActivityItem[] {
  const a = (id: string, t: number, team: string | null, kind: ActivityItem["kind"], icon: string, text: string, link: string | null): ActivityItem => ({
    id, at: ago(t), team_slug: team, kind, icon, text, link,
  });
  return [
    a("a1", 2 * MIN, "platform", "operation", "📨", "Bolt is telling Mobile their staging request was received.", "/operations"),
    a("a2", 4 * MIN, "payments", "operation", "⏳", "Pip is checking whether its reminder reached #platform.", "/operations"),
    a("a3", 12 * MIN, "platform", "approval", "🛎️", "Bolt asks to restart the checkout-api canary pool.", "/approvals"),
    a("a4", 25 * MIN, "mobile", "approval", "📝", "Echo drafted today's brief for #mobile.", "/approvals"),
    a("a5", 31 * MIN, "mobile", "brief", "☀️", "Echo wrote Mobile's daily brief.", "/teams/mobile"),
    a("a6", 40 * MIN, "payments", "approval", "📝", "Pip drafted an update on C-88 for #platform.", "/approvals"),
    a("a7", 52 * MIN, "payments", "inbox", "💬", "Pip answered Mobile's question about 3DS limits from docs.", "/teams/payments/front-desk"),
    a("a8", 2 * HOUR, "payments", "commitment", "📌", "Pip logged C-93 for Payments: incident review for checkout-api.", "/commitments/C-93"),
    a("a9", 2 * HOUR + 10 * MIN, "payments", "service", "🚨", "checkout-api is down: 503 on 1 in 8 requests.", "/services"),
    a("a10", 3 * HOUR, "mobile", "operation", "❓", "Echo's nudge to Kenji may not have posted. It needs a check.", "/operations"),
    a("a11", 5 * HOUR, "payments", "brief", "☀️", "Pip posted Payments' daily brief.", "/teams/payments"),
    a("a12", 6 * HOUR, "payments", "commitment", "⚠️", "C-88 is at risk: 2 partners haven't confirmed.", "/commitments/C-88"),
    a("a13", 9 * HOUR, "platform", "commitment", "⚠️", "C-83 is at risk: replica rebuild at 61%.", "/commitments/C-83"),
    a("a14", 20 * HOUR, "mobile", "commitment", "📌", "Echo logged C-92 for Mobile, requested by Payments.", "/commitments/C-92"),
    a("a15", 1 * DAY, "platform", "operation", "❓", "Bolt couldn't tell if the C-91 issue was created.", "/operations"),
    a("a16", 1 * DAY + HOUR, "platform", "commitment", "📌", "Bolt logged C-89 for Platform, requested by Mobile.", "/commitments/C-89"),
    a("a17", 1 * DAY + 3 * HOUR, "platform", "commitment", "✅", "Lena closed C-84: p99 latency alerts are live.", "/commitments/C-84"),
    a("a18", 2 * DAY, "payments", "commitment", "✅", "Pip closed C-87 after Mobile confirmed the answer.", "/commitments/C-87"),
    a("a19", 3 * DAY, "payments", "knowledge", "📚", "Pip learned 2 new docs from acme/payments-docs.", "/teams/payments/knowledge"),
    a("a20", 19 * DAY, "payments", "level", "🎚️", "Maya moved Pip to L2 Assist.", "/teams/payments/level"),
  ];
}

export function makeAudit(): AuditEntry[] {
  const e = (id: string, t: number, actor: string, action: string, target: string, detail: string, team: string | null): AuditEntry => ({
    id, at: ago(t), actor, action, target, detail, team_slug: team,
  });
  return [
    e("au1", 2 * MIN, "Bolt 🦫", "operation.dispatch", "c-89:ack-request", "slack.post → #mobile", "platform"),
    e("au2", 4 * MIN, "Pip 🦉", "operation.unknown", "c-90:remind-blocker", "Slack didn't confirm in time", "payments"),
    e("au3", 12 * MIN, "Bolt 🦫", "approval.request", "ap_3", "runbook.run needs L4", "platform"),
    e("au4", 25 * MIN, "Echo 🐙", "approval.request", "ap_2", "slack.post needs approval at L1", "mobile"),
    e("au5", 40 * MIN, "Pip 🦉", "approval.request", "ap_1", "slack.post to another team's channel", "payments"),
    e("au6", 52 * MIN, "Pip 🦉", "ask.answer", "front desk", "Answered from 2 sources, 1 withheld (restricted)", "payments"),
    e("au7", 2 * HOUR, "Pip 🦉", "commitment.create", "C-93", "From incident inc_204", "payments"),
    e("au8", 2 * HOUR, "Pip 🦉", "operation.done", "c-93:incident-thread", "slack.post → #payments-incidents", "payments"),
    e("au9", 2 * HOUR + 10 * MIN, "system", "incident.open", "checkout-api", "3 failed checks in a row", "payments"),
    e("au10", 3 * HOUR, "Echo 🐙", "operation.needs_review", "c-85:nudge-1", "Slack timed out after send", "mobile"),
    e("au11", 5 * HOUR, "Pip 🦉", "brief.post", "#payments", "Daily brief", "payments"),
    e("au12", 9 * HOUR, "Bolt 🦫", "operation.acked", "c-83:comment-progress", "github.comment → acme/infra#771", "platform"),
    e("au13", 1 * DAY, "Bolt 🦫", "operation.needs_review", "c-91:create-issue", "GitHub 503 after send", "platform"),
    e("au14", 1 * DAY + 3 * HOUR, "Lena Fischer", "commitment.update", "C-84", "status → done", "platform"),
    e("au15", 30 * HOUR, "Bolt 🦫", "operation.failed", "kb:sync-wiki", "permission_denied on acme/platform-wiki", "platform"),
    e("au16", 2 * DAY, "Maya Chen", "approval.approve", "ap_0", "Approved unchanged", "payments"),
    e("au17", 3 * DAY, "Pip 🦉", "knowledge.add", "Webhook secret rotation guide", "label: confidential", "payments"),
    e("au18", 6 * DAY, "Ana Lima", "approval.reject", "c-94:close-issue", "\"We still want to track this\"", "mobile"),
    e("au19", 9 * DAY, "Ana Lima", "level.change", "Echo", "L0 → L1", "mobile"),
    e("au20", 19 * DAY, "Maya Chen", "level.change", "Pip", "L1 → L2", "payments"),
    e("au21", 22 * DAY, "Lena Fischer", "level.change", "Bolt", "L2 → L3", "platform"),
    e("au22", 40 * DAY, "evan@acme.dev", "setup.slack", "Slack app", "Connected workspace acme", null),
    e("au23", 40 * DAY, "evan@acme.dev", "setup.model", "anthropic", "claude-sonnet", null),
  ];
}

export function makeCheckups(): CheckupReport[] {
  return [
    {
      id: "ck_1",
      repo: "acme/payments-api",
      status: "done",
      error_line: null,
      score: 78,
      grade: "B",
      created_at: ago(3 * DAY),
      ...checkupBody("acme/payments-api", 1),
    },
  ];
}

export function checkupBody(repo: string, seed: number): Pick<CheckupReport, "findings" | "stats"> {
  const r = rng(seed * 7 + repo.length);
  const n = (lo: number, hi: number) => Math.round(lo + r() * (hi - lo));
  const gh = `https://github.com/${repo}`;
  return {
    findings: [
      { severity: "high", title: `${n(5, 9)} promises in issues nobody tracks`, detail: "Comments like \"I'll fix this next sprint\" with no owner or date. The oldest is 47 days old.", url: `${gh}/issues?q=is%3Aopen+commented` },
      { severity: "high", title: "Default branch accepts force-pushes", detail: "Anyone with write access can rewrite main. Turn on branch protection.", url: `${gh}/settings/branches` },
      { severity: "medium", title: `${n(11, 18)} pull requests waiting over 5 days`, detail: "Median first review takes 2.8 days. Three PRs have no reviewer at all.", url: `${gh}/pulls?q=is%3Aopen+sort%3Acreated-asc` },
      { severity: "medium", title: "CI is flaky on 2 workflows", detail: "integration.yml and e2e.yml failed then passed on retry 23 times this month.", url: `${gh}/actions` },
      { severity: "medium", title: "No CODEOWNERS file", detail: "Reviews land on whoever notices. A steward can't route questions without owners.", url: null },
      { severity: "low", title: `${n(30, 60)} stale branches`, detail: "Merged or untouched for 90 days.", url: `${gh}/branches/stale` },
      { severity: "low", title: "README has no on-call or contact line", detail: "Other teams don't know where to ask.", url: `${gh}#readme` },
    ],
    stats: {
      "Open issues": n(80, 140),
      "Open PRs": n(14, 26),
      "Median PR review": "2.8d",
      "Untracked promises": n(5, 9),
      Contributors: n(12, 24),
      "CI pass rate": `${n(86, 93)}%`,
    },
  };
}

export function makeSetup(): SetupStep[] {
  return [
    { id: "admin", title: "Admin account", done: true, optional: false, detail: "The first org admin. You can add SSO later." },
    { id: "model", title: "Model", done: true, optional: false, detail: "Which model your stewards think with. Runs where you choose." },
    { id: "slack", title: "Slack", done: false, optional: true, detail: "Lets stewards read team channels and post drafts you approve." },
    { id: "github", title: "GitHub", done: false, optional: true, detail: "Lets stewards read issues and PRs and track promises in them." },
    { id: "policy", title: "Policy", done: true, optional: false, detail: "The starting level for new stewards and the default label for knowledge." },
    { id: "team", title: "First team", done: true, optional: false, detail: "Name a team and its steward. You can add more later." },
  ];
}

export { DAY, HOUR, MIN };
