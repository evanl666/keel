// In-browser mock of the Keel API. Loaded only when VITE_MOCK=1.
import { ApiError, installTransport, type Method, type StreamSource, type Transport } from "../client";
import type {
  ActivityItem,
  Approval,
  AskResult,
  Brief,
  ChatMessage,
  CheckupReport,
  Commitment,
  CommitmentDetail,
  CommitmentEvent,
  CrossTeamEdge,
  Duty,
  Gap,
  CreateInviteBody,
  Invite,
  InviteInfo,
  KnowledgeDoc,
  KnowledgeDocFull,
  KnowledgeSource,
  Label,
  LearningStats,
  Lesson,
  Level,
  Me,
  Member,
  Operation,
  OrgRole,
  PatchKnowledgeBody,
  PatchTeamBody,
  TeamDetail,
  TeamRole,
  Overview,
  Service,
  SetupStepId,
  TeamSummary,
} from "../types";
import * as D from "./data";
import * as S from "./share";

const OPEN = new Set(["proposed", "accepted", "in_progress", "blocked"]);
const SIGNED_OUT_KEY = "keel-mock-signed-out";
const user = { id: "u_evan", name: "Evan", email: "evan@acme.dev", role: "org_admin" as const, avatar_url: null };

const state = {
  teams: D.makeTeams(),
  commitments: D.makeCommitments(),
  events: D.makeEvents(),
  operations: D.makeOperations(),
  approvals: D.makeApprovals(),
  services: D.makeServices(),
  knowledge: D.makeKnowledge(),
  learning: D.makeLearning(),
  briefs: D.makeBriefs(),
  chat: D.makeChat(),
  levels: D.makeLevels(),
  activity: D.makeActivity(),
  audit: D.makeAudit(),
  checkups: D.makeCheckups(),
  setup: D.makeSetup(),
  sources: D.makeKnowledgeSources(),
  people: D.makePeople(),
  invites: D.makeInvites(),
  // One-time invite links: token -> invite id. "demo" works in the mock; "old" has expired.
  inviteTokens: { demo: "inv_2", old: "inv_0" } as Record<string, string>,
  settings: D.makeTeamSettings(),
  tick: 0,
  seq: 1000,
};

const approvalOp: Record<string, string> = { ap_1: "c-88:update-platform", ap_2: "brief:mobile:daily" };
const listeners = new Set<(a: ActivityItem) => void>();

const nid = (p: string) => `${p}_${++state.seq}`;
const now = () => new Date().toISOString();
const team = (slug: string) => {
  const t = state.teams.find((x) => x.slug === slug);
  if (!t) throw new ApiError(404, `There is no team called "${slug}".`);
  return t;
};
const stewardTag = (slug: string) => {
  const s = team(slug).steward;
  return `${s.name} ${s.emoji}`;
};

function emit(item: Omit<ActivityItem, "id" | "at">): ActivityItem {
  const a: ActivityItem = { id: nid("act"), at: now(), ...item };
  state.activity.unshift(a);
  state.activity = state.activity.slice(0, 60);
  listeners.forEach((l) => l(a));
  return a;
}

function audit(actor: string, action: string, target: string, detail: string, team_slug: string | null) {
  state.audit.unshift({ id: nid("au"), at: now(), actor, action, target, detail, team_slug });
}

function computeTeam(t: D.MockTeam): TeamSummary {
  const owned = state.commitments.filter((c) => c.owner_team === t.slug && OPEN.has(c.status));
  const at_risk = owned.filter((c) => c.risk === "at_risk").length;
  const overdue = owned.filter((c) => c.risk === "overdue").length;
  const pending = state.approvals.filter((a) => a.team_slug === t.slug && a.status === "pending").length;
  const incidents = (state.services[t.slug] ?? []).filter((s) => s.open_incident).length;
  const review = state.operations.filter((o) => o.team_slug === t.slug && o.status === "needs_review").length;
  const requests_in = owned.filter((c) => c.requester_team && c.requester_team !== t.slug).length;
  const requests_out = state.commitments.filter((c) => c.requester_team === t.slug && c.owner_team !== t.slug && OPEN.has(c.status)).length;
  const health = Math.max(18, Math.min(100, 100 - at_risk * 9 - overdue * 14 - incidents * 16 - pending * 3 - review * 5));
  const s = t.steward;
  let status_line: string;
  if (s.paused) status_line = `Paused. ${s.name} watches but sends nothing.`;
  else {
    const svc = (state.services[t.slug] ?? []).find((x) => x.open_incident);
    const lead = svc ? `Following the ${svc.name} incident.` : `Watching ${t.channel} and ${(state.services[t.slug] ?? []).length || "no"} services.`;
    const tail = pending ? `${pending} ${pending === 1 ? "draft waits" : "drafts wait"} for you.` : "Nothing waits for you.";
    status_line = `${lead} ${tail}`;
  }
  const { channel: _c, members: _m, ...rest } = t;
  void _c;
  void _m;
  return {
    ...rest,
    health,
    steward: { ...s, level_name: D.LEVEL_NAMES[s.level], status_line },
    counts: { open: owned.length, at_risk, overdue, pending_approvals: pending, incidents_open: incidents, requests_in, requests_out },
  };
}

function overview(): Overview {
  const teams = state.teams.map(computeTeam);
  const edges = new Map<string, CrossTeamEdge>();
  for (const c of state.commitments) {
    if (!c.requester_team || c.requester_team === c.owner_team || !OPEN.has(c.status)) continue;
    const k = `${c.requester_team}>${c.owner_team}`;
    const e = edges.get(k) ?? { from_team: c.requester_team, to_team: c.owner_team, open: 0, at_risk: 0 };
    e.open += 1;
    if (c.risk === "at_risk" || c.risk === "overdue") e.at_risk += 1;
    edges.set(k, e);
  }
  const open = state.commitments.filter((c) => OPEN.has(c.status));
  const weekAgo = Date.now() - 7 * D.DAY;
  return {
    org: { id: "org_acme", name: "Acme" },
    teams,
    cross_team: [...edges.values()],
    totals: {
      open: open.length,
      done_7d: state.commitments.filter((c) => c.status === "done" && Date.parse(c.updated_at) > weekAgo).length + 9,
      at_risk: open.filter((c) => c.risk === "at_risk").length,
      overdue: open.filter((c) => c.risk === "overdue").length,
      pending_approvals: state.approvals.filter((a) => a.status === "pending").length,
      incidents_open: Object.values(state.services).flat().filter((s) => s.open_incident).length,
      ops_needs_review: state.operations.filter((o) => o.status === "needs_review").length,
    },
    activity: state.activity.slice(0, 30),
  };
}

function detail(key: string): CommitmentDetail {
  const c = state.commitments.find((x) => x.key.toLowerCase() === key.toLowerCase());
  if (!c) throw new ApiError(404, `There is no commitment ${key}.`);
  const prefix = c.key.toLowerCase() + ":";
  const events = state.events[c.key] ?? [
    { id: `${c.key}-e0`, at: c.created_at, actor: stewardTag(c.owner_team), kind: "logged", text: `Logged ${c.key} for ${team(c.owner_team).name}.` },
  ];
  return { ...c, events: [...events].sort((a, b) => a.at.localeCompare(b.at)), operations: state.operations.filter((o) => o.op_id.startsWith(prefix)) };
}

function addEvent(key: string, actor: string, kind: string, text: string) {
  const list = state.events[key] ?? (state.events[key] = [...detail(key).events]);
  const e: CommitmentEvent = { id: nid("ev"), at: now(), actor, kind, text };
  list.push(e);
}

function settleLater(o: Operation, ms = 1600) {
  setTimeout(() => {
    o.status = "acked";
    o.updated_at = now();
    setTimeout(() => {
      o.status = "done";
      o.remote_ref = o.remote_ref ?? (o.kind.startsWith("slack") ? "https://acme.slack.com/archives/C0X/p" + Date.now() : o.kind.startsWith("github") ? `https://github.com/${o.target.split("#")[0]}/issues/${400 + (state.seq % 90)}` : `run-${state.seq}`);
      o.updated_at = now();
    }, ms);
  }, ms);
}

function newOp(p: Pick<Operation, "op_id" | "team_slug" | "kind" | "target" | "summary" | "status">): Operation {
  const o: Operation = { id: nid("op"), attempts: 1, error_class: null, error_line: null, remote_ref: null, created_at: now(), updated_at: now(), ...p };
  state.operations.unshift(o);
  return o;
}

function logGap(slug: string, question: string) {
  const t = team(slug);
  const q = question.replace(/^(@[\w.-]+[,:]?\s*)+/, "").trim();
  const list = (state.learning.gaps[slug] ??= []);
  const same = list.find((g) => (g.status === "open" || g.status === "suggested") && g.question.toLowerCase() === q.toLowerCase());
  if (same) {
    same.count += 1;
    same.last_asked_at = now();
    return;
  }
  list.unshift({ id: nid("gp"), question: q[0].toUpperCase() + q.slice(1), asked_by: user.name, count: 1, status: "open", suggested_answer: null, suggested_by: null, doc_id: null, closed_by: null, created_at: now(), last_asked_at: now(), closed_at: null });
  emit({ team_slug: slug, kind: "learning", icon: "❓", text: `Open question for ${t.name}: ${q}`, link: `/teams/${slug}/learning` });
}

function learningStats(slug: string): LearningStats {
  const ls = state.learning.lessons[slug] ?? [];
  const gs = state.learning.gaps[slug] ?? [];
  const week = Date.now() - 7 * 86_400_000;
  const recent = (s: string | null) => !!s && Date.parse(s) >= week;
  const rates: Record<string, [number, number]> = { payments: [0.86, 0.71], platform: [0.93, 0.9], mobile: [0.64, 0.64] };
  const [rate, before] = rates[slug] ?? [null, null];
  return {
    lessons_active: ls.filter((l) => l.active).length,
    rules: ls.filter((l) => l.active && l.kind === "rule").length,
    learned_this_week: ls.filter((l) => recent(l.created_at)).length,
    used_this_week: ls.filter((l) => recent(l.last_used_at)).length,
    open_questions: gs.filter((g) => g.status === "open" || g.status === "suggested").length,
    suggested_answers: gs.filter((g) => g.status === "suggested").length,
    filled_total: gs.filter((g) => g.status === "filled").length + (slug === "payments" ? 7 : 0),
    unedited_rate: rate,
    unedited_rate_before: before,
  };
}

function findGap(id: string): [string, Gap] {
  for (const [slug, list] of Object.entries(state.learning.gaps)) {
    const g = list.find((x) => x.id === id);
    if (g) return [slug, g];
  }
  throw new ApiError(404, "That question doesn't exist.");
}

function askAnswer(slug: string, question: string): AskResult {
  const ql = question.toLowerCase();
  const docs = state.knowledge[slug] ?? [];
  const words = ql.split(/\W+/).filter((w) => w.length > 2);
  const scored = docs
    .map((d) => ({ d, s: words.filter((w) => (d.title + " " + d.snippet).toLowerCase().includes(w)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const visible = scored.filter((x) => x.d.label === "public" || x.d.label === "internal");
  const hidden = scored.length - visible.length + (/(pci|secret|access|scope|key)/.test(ql) ? 1 : 0);
  if (!visible.length) {
    if (!hidden) logGap(slug, question);
    return {
      open_question: !hidden,
      answer: hidden
        ? "I found docs on this, but they're labeled above what this audience can see. Ask the team directly and I'll pass it on."
        : `I don't have a doc that answers that yet. I've noted the question for ${team(slug).name}.`,
      label: "internal",
      sources: [],
      withheld: Math.min(hidden, 3),
    };
  }
  const top = visible.slice(0, 2).map((x) => x.d);
  return {
    answer: `${top[0].snippet}${top[1] ? `\n\nRelated: ${top[1].snippet}` : ""}`,
    label: top.some((d) => d.label === "internal") ? "internal" : "public",
    sources: top.map((d) => ({ title: d.title, source: d.source, label: d.label, url: d.source_url })),
    withheld: Math.min(hidden, 3),
  };
}

function chatReply(slug: string, message: string): ChatMessage[] {
  const t = team(slug);
  const s = t.steward;
  const ml = message.toLowerCase();
  const open = state.commitments.filter((c) => c.owner_team === slug && OPEN.has(c.status));
  if (s.paused) return [{ role: "steward", text: `I'm paused, so I won't send anything. I can still answer: you have ${open.length} open commitments.`, at: now() }];
  if (/risk|late|overdue|worry/.test(ml)) {
    const risky = open.filter((c) => c.risk === "at_risk" || c.risk === "overdue");
    if (!risky.length) return [{ role: "steward", text: "Nothing is at risk right now. 🎉", at: now() }];
    return [
      {
        role: "steward",
        text: `${risky.length} ${risky.length === 1 ? "thing needs" : "things need"} a look:\n\n${risky.map((c) => `- **${c.key}** ${c.title} (${c.risk === "overdue" ? "overdue" : "at risk"})`).join("\n")}`,
        at: now(),
        actions: risky.slice(0, 2).map((c) => ({ kind: "open", text: `Open ${c.key}`, link: `/commitments/${c.key}` })),
      },
    ];
  }
  if (/brief|today|summary/.test(ml)) {
    return [{ role: "steward", text: `Today: ${open.length} open, ${open.filter((c) => c.risk !== "on_track" && c.risk !== "none").length} need attention. The full brief is on the Today tab.`, at: now(), actions: [{ kind: "open", text: "Open Today", link: `/teams/${slug}` }] }];
  }
  const a = askAnswer(slug, message);
  return [{ role: "steward", text: a.answer, at: now(), sources: a.sources.length ? a.sources : undefined }];
}

function makeBrief(slug: string, kind: "daily" | "weekly"): Brief {
  const t = team(slug);
  const owned = state.commitments.filter((c) => c.owner_team === slug && OPEN.has(c.status));
  const risky = owned.filter((c) => c.risk === "at_risk" || c.risk === "overdue");
  const fine = owned.filter((c) => !risky.includes(c));
  const pending = state.approvals.filter((a) => a.team_slug === slug && a.status === "pending").length;
  const day = new Date().toLocaleDateString("en-US", { weekday: "long" });
  const md = [
    `Fresh ${kind} brief from ${t.steward.name} ${t.steward.emoji}.`,
    "",
    "### Needs you",
    ...(risky.length ? risky.map((c) => `- **${c.key} ${c.title}** is ${c.risk === "overdue" ? "**overdue**" : "*at risk*"}.`) : ["- Nothing. Enjoy the quiet."]),
    "",
    "### Moving fine",
    ...(fine.length ? fine.slice(0, 5).map((c) => `- ${c.key} ${c.title}`) : ["- No other open commitments."]),
    "",
    `> ${pending ? `${pending} ${pending === 1 ? "draft waits" : "drafts wait"} for your approval.` : "No drafts wait for you."}`,
  ].join("\n");
  const b: Brief = { id: nid("br"), team_slug: slug, kind, created_at: now(), title: `${t.name} · ${kind === "daily" ? day : "This week"}`, markdown: md };
  (state.briefs[slug] ??= []).unshift(b);
  emit({ team_slug: slug, kind: "brief", icon: "☀️", text: `${t.steward.name} wrote a ${kind} brief for ${t.name}.`, link: `/teams/${slug}` });
  return b;
}

const ambient: [string, ActivityItem["kind"], string, (s: string) => string, string | null][] = [
  ["payments", "inbox", "💬", (n) => `${n} answered a question from Mobile about refund limits.`, "/teams/payments/front-desk"],
  ["platform", "service", "💚", () => "api-gateway passed 60 checks in a row.", "/services"],
  ["mobile", "commitment", "👀", (n) => `${n} noticed a promise in #mobile: "I'll ship the fix Monday".`, "/teams/mobile/ledger"],
  ["platform", "chat", "💬", (n) => `${n} told Sam that C-83 is at 68%.`, "/commitments/C-83"],
  ["payments", "knowledge", "📚", (n) => `${n} re-read the refund policy runbook after an edit.`, "/teams/payments/knowledge"],
  ["mobile", "inbox", "📮", (n) => `${n} routed a question to Payments' front desk.`, null],
  ["payments", "service", "🩺", () => "checkout-api: 6 of the last 8 checks passed.", "/services"],
  ["platform", "operation", "📨", (n) => `${n} posted a reminder in #platform.`, "/operations"],
];
let ambientIdx = 0;

const script: (() => ActivityItem)[] = [
  () => {
    const c: Commitment = {
      key: "C-96", title: "Show refund status in the mobile app", detail: "Mobile wants refund state from mobile-bff so users stop opening tickets.",
      status: "proposed", risk: "none", priority: "normal", owner_team: "payments", requester_team: "mobile", owner_person: null, requester_person: "Ana Lima",
      due_at: new Date(Date.now() + 6 * D.DAY).toISOString(), created_at: now(), updated_at: now(), source_url: null, source_kind: "steward", label: "internal",
    };
    state.commitments.push(c);
    state.events["C-96"] = [
      { id: nid("ev"), at: now(), actor: "Ana Lima", kind: "message", text: "Asked Echo: \"Can Payments expose refund status to the app?\"" },
      { id: nid("ev"), at: now(), actor: "Echo 🐙", kind: "request", text: "Sent the request to Pip for Payments." },
      { id: nid("ev"), at: now(), actor: "Pip 🦉", kind: "logged", text: "Logged C-96 for Payments. No owner yet." },
    ];
    audit("Pip 🦉", "commitment.create", "C-96", "Request from Mobile via Echo", "payments");
    return emit({ team_slug: "payments", kind: "commitment", icon: "📌", text: "Echo asked Pip for refund status in the app. Logged as C-96.", link: "/commitments/C-96" });
  },
  () => {
    state.approvals.unshift({
      id: "ap_5", team_slug: "payments", created_at: now(), kind: "slack.post", title: "Reply in #mobile",
      preview: "Hi Mobile 👋 Payments got your request (**C-96**). Maya will pick an owner by tomorrow. We'll reply here with a date.",
      reason: "Pip is at L2 Assist: posts in another team's channel need approval.", label: "internal", audience: "#mobile (11 people)", commitment_key: "C-96", status: "pending",
    });
    newOp({ op_id: "c-96:ack-mobile", team_slug: "payments", kind: "slack.post", target: "#mobile", summary: "Tell Mobile the request was received", status: "awaiting_approval" }).attempts = 0;
    approvalOp.ap_5 = "c-96:ack-mobile";
    return emit({ team_slug: "payments", kind: "approval", icon: "📝", text: "Pip drafted a reply to Mobile about C-96.", link: "/approvals" });
  },
  () => {
    const s = state.services.payments[0];
    s.state = "up";
    s.open_incident = null;
    s.checks = [...s.checks.slice(8), ...Array.from({ length: 8 }, (_, i) => ({ at: new Date(Date.now() - (7 - i) * 60000).toISOString(), ok: true, latency_ms: 80 + Math.round(Math.random() * 25), status_code: 200 }))];
    audit("system", "incident.close", "checkout-api", "8 checks in a row passed", "payments");
    return emit({ team_slug: "payments", kind: "service", icon: "💚", text: "checkout-api is back. 8 checks in a row passed.", link: "/services" });
  },
  () => {
    const c = state.commitments.find((x) => x.key === "C-88")!;
    c.risk = "on_track";
    c.updated_at = now();
    addEvent("C-88", "Pip 🦉", "risk", "Back on track: all 5 partners confirmed the overlap window.");
    return emit({ team_slug: "payments", kind: "commitment", icon: "✅", text: "C-88 is back on track. All 5 partners confirmed.", link: "/commitments/C-88" });
  },
  () => {
    const c83 = state.commitments.find((x) => x.key === "C-83")!;
    c83.status = "done";
    c83.risk = "none";
    c83.updated_at = now();
    addEvent("C-83", "Sam Okafor", "status", "Done. ledger-db runs Postgres 16.");
    const c90 = state.commitments.find((x) => x.key === "C-90")!;
    c90.status = "in_progress";
    c90.risk = "on_track";
    c90.updated_at = now();
    addEvent("C-90", "Pip 🦉", "unblocked", "Unblocked: C-83 is done.");
    return emit({ team_slug: "platform", kind: "commitment", icon: "🎉", text: "Platform finished C-83. Pip unblocked C-90.", link: "/commitments/C-83" });
  },
  () => {
    state.knowledge.platform.unshift(newDoc({ title: "Staging env checklist", source: "Notion · Platform/Self-serve", label: "internal", snippet: "DNS, secrets, seed data and a smoke test. Takes about 40 minutes.", chars: 2210 }));
    return emit({ team_slug: "platform", kind: "knowledge", icon: "📚", text: "Bolt learned a new doc: Staging env checklist.", link: "/teams/platform/knowledge" });
  },
];

const contents: Record<string, string> = {};
const dayFrom = (days: number) => new Date(Date.now() + days * D.DAY).toISOString().slice(0, 10);

function newDoc(p: Pick<KnowledgeDoc, "title" | "source" | "label" | "snippet" | "chars"> & Partial<KnowledgeDoc>): KnowledgeDoc {
  return { id: nid("kd"), updated_at: now(), origin: "manual", source_url: null, review_by: dayFrom(90), stale: false, sync_id: null, ...p };
}

function teamDetail(t: D.MockTeam): TeamDetail {
  const me = state.people.find((p) => p.id === user.id)?.teams.find((x) => x.slug === t.slug);
  return {
    ...computeTeam(t),
    today: state.briefs[t.slug]?.find((b) => b.kind === "daily") ?? null,
    activity: state.activity.filter((a) => a.team_slug === t.slug).slice(0, 20),
    settings: (state.settings[t.slug] ??= { slack_channel: null, slack_channel_id: null, slack_connected: true, github_repos: [], timezone: "UTC", brief_hour: 9, sso_groups: [] }),
    my_role: me?.role ?? null,
  };
}

function members(slug: string): Member[] {
  return state.people
    .filter((p) => !p.disabled)
    .flatMap((p) => p.teams.filter((x) => x.slug === slug).map((x) => ({ user_id: p.id, name: p.name, email: p.email, role: x.role, avatar_url: p.avatar_url })));
}

function person(id: string) {
  const p = state.people.find((x) => x.id === id);
  if (!p) throw new ApiError(404, "That person isn't in this workspace.");
  return p;
}

function findDoc(slug: string, id: string) {
  const d = (state.knowledge[slug] ?? []).find((x) => x.id === id);
  if (!d) throw new ApiError(404, "That doc doesn't exist any more.");
  return d;
}

function findSource(slug: string, id: string) {
  const s = (state.sources[slug] ?? []).find((x) => x.id === id);
  if (!s) throw new ApiError(404, "That source doesn't exist any more.");
  return s;
}

function syncLater(slug: string, src: KnowledgeSource) {
  src.status = "pending";
  src.status_line = "Syncing…";
  setTimeout(() => {
    const t = team(slug);
    if (src.kind === "url" && /login|sso|intranet/.test(src.target)) {
      Object.assign(src, { status: "error", status_line: "The page asked for a login. Keel can only read public pages.", last_synced_at: now() });
      return;
    }
    const docs = state.knowledge[slug] ?? [];
    if (!docs.some((d) => d.sync_id === src.id)) {
      const name = src.target.split("/").filter(Boolean).pop() ?? src.target;
      const title = name.replace(/[-_]/g, " ").replace(/\.\w+$/, "").replace(/^\w/, (c) => c.toUpperCase());
      const d = newDoc({ title, source: src.kind === "github" ? `GitHub · ${src.target}` : `Web · ${new URL(src.target).host}`, label: src.label, snippet: `Synced from ${src.target}.`, chars: 1600, origin: src.kind, source_url: src.kind === "github" ? `https://github.com/${src.target}` : src.target, sync_id: src.id, review_by: null });
      docs.unshift(d);
      state.knowledge[slug] = docs;
      emit({ team_slug: slug, kind: "knowledge", icon: "📚", text: `${t.steward.name} synced ${d.title} from ${src.target}.`, link: `/teams/${slug}/knowledge` });
    }
    const n = docs.filter((d) => d.sync_id === src.id).length;
    Object.assign(src, { status: "ok", status_line: `Synced ${n} ${src.kind === "url" ? (n === 1 ? "page" : "pages") : n === 1 ? "doc" : "docs"}.`, docs: n, last_synced_at: now() });
  }, 1800);
}

function adminRoutes(): [Method, RegExp, Handler][] {
  const KNOWN_CHANNELS: Record<string, string> = { "#payments": "C024PAY", "#platform": "C031PLT", "#payments-incidents": "C024INC", "#eng": "C001ENG" };
  const adminOnly = () => {
    if (user.role !== "org_admin") throw new ApiError(403, "Only org admins can do that.");
  };
  return [
    ["PATCH", /^\/api\/teams\/([\w-]+)$/, (m, b) => {
      const t = team(m[1]);
      const p = body<PatchTeamBody>(b);
      const st = teamDetail(t).settings;
      if (p.name !== undefined) {
        if (!p.name.trim()) throw new ApiError(400, "Give the team a name.");
        t.name = p.name.trim();
      }
      if (p.slack_channel !== undefined) {
        const ch = p.slack_channel.trim();
        st.slack_channel = ch ? (ch.startsWith("#") || /^C[A-Z0-9]+$/.test(ch) ? ch : `#${ch}`) : null;
        st.slack_channel_id = st.slack_channel && st.slack_connected ? (KNOWN_CHANNELS[st.slack_channel] ?? (/^C[A-Z0-9]+$/.test(ch) ? ch : null)) : null;
        if (st.slack_channel) t.channel = st.slack_channel;
      }
      if (p.github_repos !== undefined) {
        const bad = p.github_repos.find((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
        if (bad) throw new ApiError(400, `"${bad}" isn't a repo. Use owner/name, like acme/payments-api.`);
        st.github_repos = p.github_repos;
      }
      if (p.timezone !== undefined) st.timezone = p.timezone;
      if (p.brief_hour !== undefined) {
        if (p.brief_hour < 0 || p.brief_hour > 23) throw new ApiError(400, "The brief hour must be between 0 and 23.");
        st.brief_hour = p.brief_hour;
      }
      if (p.sso_groups !== undefined) st.sso_groups = p.sso_groups;
      audit(user.email, "team.update", t.slug, Object.keys(p).join(", "), t.slug);
      return teamDetail(t);
    }],
    ["DELETE", /^\/api\/teams\/([\w-]+)$/, (m, _b, url) => {
      adminOnly();
      const t = team(m[1]);
      if (url.searchParams.get("confirm") !== t.slug) throw new ApiError(400, `Type ${t.slug} to confirm.`);
      state.teams = state.teams.filter((x) => x.slug !== t.slug);
      for (const p of state.people) p.teams = p.teams.filter((x) => x.slug !== t.slug);
      audit(user.email, "team.delete", t.slug, `Deleted ${t.name}`, null);
      return { ok: true, message: `${t.name} is gone. Its ledger stays in the audit log.` };
    }],
    ["GET", /^\/api\/teams\/([\w-]+)\/members$/, (m) => members(team(m[1]).slug)],
    ["POST", /^\/api\/teams\/([\w-]+)\/members$/, (m, b) => {
      const t = team(m[1]);
      const p = body<{ email: string; role: TeamRole }>(b);
      const who = state.people.find((x) => x.email.toLowerCase() === (p.email ?? "").trim().toLowerCase());
      if (!who) throw new ApiError(404, "No one with that email yet. Invite them first.");
      if (who.teams.some((x) => x.slug === t.slug)) throw new ApiError(409, `${who.name} is already in ${t.name}.`);
      who.teams.push({ slug: t.slug, name: t.name, role: p.role ?? "member" });
      audit(user.email, "member.add", who.email, `${p.role ?? "member"} of ${t.name}`, t.slug);
      return members(t.slug).find((x) => x.user_id === who.id);
    }],
    ["PATCH", /^\/api\/teams\/([\w-]+)\/members\/(\w+)$/, (m, b) => {
      const t = team(m[1]);
      const pt = person(m[2]).teams.find((x) => x.slug === t.slug);
      if (!pt) throw new ApiError(404, "They aren't in this team.");
      const role = body<{ role: TeamRole }>(b).role;
      if (pt.role === "admin" && role !== "admin" && members(t.slug).filter((x) => x.role === "admin").length === 1)
        throw new ApiError(409, "A team needs at least one admin. Make someone else admin first.");
      pt.role = role;
      return members(t.slug).find((x) => x.user_id === m[2]);
    }],
    ["DELETE", /^\/api\/teams\/([\w-]+)\/members\/(\w+)$/, (m) => {
      const t = team(m[1]);
      const p = person(m[2]);
      p.teams = p.teams.filter((x) => x.slug !== t.slug);
      audit(user.email, "member.remove", p.email, `Removed from ${t.name}`, t.slug);
      return { ok: true, message: `${p.name} is no longer in ${t.name}.` };
    }],

    ["GET", /^\/api\/people$/, () => {
      adminOnly();
      return state.people;
    }],
    ["PATCH", /^\/api\/people\/(\w+)$/, (m, b) => {
      adminOnly();
      const p = person(m[1]);
      const x = body<{ role?: OrgRole; disabled?: boolean }>(b);
      const admins = state.people.filter((q) => q.role === "org_admin" && !q.disabled);
      const demoting = (x.role && x.role !== "org_admin") || x.disabled;
      if (demoting && p.id === user.id) throw new ApiError(409, "You can't do that to yourself. Ask another admin.");
      if (demoting && p.role === "org_admin" && admins.length === 1) throw new ApiError(409, "Keel needs at least one admin.");
      if (x.role) p.role = x.role;
      if (x.disabled !== undefined) p.disabled = x.disabled;
      audit(user.email, x.disabled !== undefined ? (x.disabled ? "person.disable" : "person.enable") : "person.role", p.email, x.role ?? "", null);
      return p;
    }],
    ["DELETE", /^\/api\/people\/(\w+)$/, (m) => {
      adminOnly();
      const p = person(m[1]);
      if (p.id === user.id) throw new ApiError(409, "You can't remove yourself. Ask another admin.");
      state.people = state.people.filter((x) => x.id !== p.id);
      audit(user.email, "person.remove", p.email, "", null);
      return { ok: true, message: `${p.name} is removed.` };
    }],
    ["GET", /^\/api\/invites$/, () => {
      adminOnly();
      return [...state.invites].sort((a, b) => b.created_at.localeCompare(a.created_at));
    }],
    ["POST", /^\/api\/invites$/, (_m, b) => {
      adminOnly();
      const p = body<CreateInviteBody>(b);
      const email = (p.email ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, "That email address doesn't look right.");
      if (state.people.some((x) => x.email === email)) throw new ApiError(409, "They're already in Acme.");
      if (state.invites.some((x) => x.email === email && x.status === "pending")) throw new ApiError(409, "They already have an invite. Revoke it to send a new one.");
      const inv: Invite = {
        id: nid("inv"),
        email,
        role: p.role ?? "member",
        teams: (p.teams ?? []).map((x) => ({ slug: x.slug, name: team(x.slug).name, role: x.role })),
        invited_by: user.name,
        created_at: now(),
        expires_at: new Date(Date.now() + 7 * D.DAY).toISOString(),
        status: "pending",
      };
      state.invites.unshift(inv);
      const token = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
      state.inviteTokens[token] = inv.id;
      audit(user.email, "invite.create", email, inv.teams.map((x) => x.name).join(", ") || "no teams", null);
      return { invite: inv, url: `/invite/${token}` };
    }],
    ["DELETE", /^\/api\/invites\/(\w+)$/, (m) => {
      adminOnly();
      const inv = state.invites.find((x) => x.id === m[1]);
      if (!inv) throw new ApiError(404, "That invite doesn't exist.");
      inv.status = "revoked";
      audit(user.email, "invite.revoke", inv.email, "", null);
      return { ok: true, message: `The invite for ${inv.email} no longer works.` };
    }],
    ["GET", /^\/api\/invite\/(\w+)$/, (m): InviteInfo => {
      const id = state.inviteTokens[m[1]];
      if (id === "inv_0") return { email: "old@acme.dev", org: "Acme", invited_by: "Maya Chen", teams: ["Payments"], status: "expired", sso_enabled: true };
      const inv = state.invites.find((x) => x.id === id);
      if (!inv) throw new ApiError(404, "This invite link doesn't work. Ask whoever sent it for a new one.");
      return { email: inv.email, org: "Acme", invited_by: inv.invited_by, teams: inv.teams.map((x) => x.name), status: inv.status, sso_enabled: true };
    }],
    ["POST", /^\/api\/invite\/(\w+)$/, (m, b) => {
      const inv = state.invites.find((x) => x.id === state.inviteTokens[m[1]]);
      if (!inv || inv.status !== "pending") throw new ApiError(410, "This invite has already been used or has expired.");
      const p = body<{ name: string; password: string }>(b);
      if (!p.name?.trim()) throw new ApiError(400, "Tell us your name.");
      if ((p.password ?? "").length < 12) throw new ApiError(400, "Use a password with at least 12 characters.");
      inv.status = "accepted";
      state.people.push({ id: nid("u"), name: p.name.trim(), email: inv.email, role: inv.role, avatar_url: null, disabled: false, sso: false, slack_linked: false, github_login: null, teams: inv.teams, created_at: now(), last_seen_at: now() });
      localStorage.removeItem(SIGNED_OUT_KEY);
      return { ok: true, message: "Welcome to Acme." };
    }],

    ["GET", /^\/api\/teams\/([\w-]+)\/knowledge\/(\w+)$/, (m): KnowledgeDocFull => {
      const slug = team(m[1]).slug;
      const d = findDoc(slug, m[2]);
      return { ...d, content: contents[d.id] ?? D.docContent(d) };
    }],
    ["PATCH", /^\/api\/teams\/([\w-]+)\/knowledge\/(\w+)$/, (m, b) => {
      const slug = team(m[1]).slug;
      const d = findDoc(slug, m[2]);
      if (d.sync_id) throw new ApiError(409, "This doc is synced from its source. Edit it there.");
      const p = body<PatchKnowledgeBody>(b);
      if (p.title !== undefined) {
        if (!p.title.trim()) throw new ApiError(400, "A doc needs a title.");
        d.title = p.title.trim();
      }
      if (p.content !== undefined) {
        contents[d.id] = p.content;
        d.snippet = p.content.replace(/^#.*$/m, "").trim().slice(0, 180);
        d.chars = p.content.length;
      }
      if (p.label) d.label = p.label;
      if (p.review_by !== undefined) {
        d.review_by = p.review_by || null;
        d.stale = !!d.review_by && d.review_by < dayFrom(0);
      }
      d.updated_at = now();
      audit(user.email, "knowledge.update", d.title, Object.keys(p).join(", "), slug);
      return d;
    }],
    ["DELETE", /^\/api\/teams\/([\w-]+)\/knowledge\/(\w+)$/, (m) => {
      const slug = team(m[1]).slug;
      const d = findDoc(slug, m[2]);
      state.knowledge[slug] = state.knowledge[slug].filter((x) => x.id !== d.id);
      audit(user.email, "knowledge.delete", d.title, "", slug);
      return { ok: true, message: `${team(slug).steward.name} forgot ${d.title}.` };
    }],
    ["POST", /^\/api\/teams\/([\w-]+)\/knowledge\/(\w+)\/reviewed$/, (m) => {
      const slug = team(m[1]).slug;
      const d = findDoc(slug, m[2]);
      d.review_by = dayFrom(90);
      d.stale = false;
      audit(user.email, "knowledge.reviewed", d.title, `Review by ${d.review_by}`, slug);
      return d;
    }],
    ["GET", /^\/api\/teams\/([\w-]+)\/knowledge-sources$/, (m) => state.sources[team(m[1]).slug] ?? []],
    ["POST", /^\/api\/teams\/([\w-]+)\/knowledge-sources$/, (m, b) => {
      const slug = team(m[1]).slug;
      const p = body<{ kind: KnowledgeSource["kind"]; target: string; label: Label }>(b);
      const target = (p.target ?? "").trim().replace(/^https:\/\/github\.com\//, p.kind === "github" ? "" : "https://github.com/");
      if (p.kind === "url" && !/^https?:\/\/\S+\.\S+/.test(target)) throw new ApiError(400, "Paste a full link that starts with https://.");
      if (p.kind === "github" && !/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?$/.test(target)) throw new ApiError(400, "Use owner/repo or owner/repo/path/to/folder.");
      const src: KnowledgeSource = { id: nid("ks"), kind: p.kind, target, label: p.label ?? "internal", last_synced_at: null, status: "pending", status_line: "Syncing…", docs: 0 };
      (state.sources[slug] ??= []).push(src);
      audit(user.email, "knowledge_source.add", target, p.kind, slug);
      syncLater(slug, src);
      return src;
    }],
    ["POST", /^\/api\/teams\/([\w-]+)\/knowledge-sources\/(\w+)\/sync$/, (m) => {
      const slug = team(m[1]).slug;
      const src = findSource(slug, m[2]);
      syncLater(slug, src);
      return src;
    }],
    ["DELETE", /^\/api\/teams\/([\w-]+)\/knowledge-sources\/(\w+)$/, (m) => {
      const slug = team(m[1]).slug;
      const src = findSource(slug, m[2]);
      state.sources[slug] = state.sources[slug].filter((x) => x.id !== src.id);
      const before = (state.knowledge[slug] ?? []).length;
      state.knowledge[slug] = (state.knowledge[slug] ?? []).filter((d) => d.sync_id !== src.id);
      audit(user.email, "knowledge_source.remove", src.target, "", slug);
      return { ok: true, message: `Removed ${src.target} and its ${before - state.knowledge[slug].length} docs.` };
    }],
  ];
}

function body<T>(b: unknown): T {
  return (b ?? {}) as T;
}

type Handler = (m: RegExpMatchArray, b: unknown, url: URL) => unknown | Promise<unknown>;
const routes: [Method, RegExp, Handler][] = [
  ["GET", /^\/api\/me$/, (): Me => ({
    user: localStorage.getItem(SIGNED_OUT_KEY) ? null : user,
    org: { id: "org_acme", name: "Acme" },
    demo: true,
    setup_complete: true,
    sso_enabled: true,
    version: "0.1.0-mock",
  })],
  ["POST", /^\/api\/auth\/login$/, (_m, b): Me => {
    const { email, password } = body<{ email: string; password: string }>(b);
    if (!email || !password) throw new ApiError(400, "Enter your email and password.");
    if (password === "wrong") throw new ApiError(401, "That email and password don't match.");
    localStorage.removeItem(SIGNED_OUT_KEY);
    return { user, org: { id: "org_acme", name: "Acme" }, demo: true, setup_complete: true, sso_enabled: true, version: "0.1.0-mock" };
  }],
  ["POST", /^\/api\/auth\/logout$/, () => {
    localStorage.setItem(SIGNED_OUT_KEY, "1");
    return { ok: true };
  }],
  ["GET", /^\/api\/setup$/, () => ({ steps: state.setup, slack_manifest_url: "/api/setup/slack-manifest", needs_setup_code: !state.setup.find((x) => x.id === "admin")?.done })],
  ["POST", /^\/api\/setup\/(\w+)\/test$/, (m, b) => setupTest(m[1] as SetupStepId, body(b))],
  ["POST", /^\/api\/setup\/(\w+)$/, (m, b) => {
    const t = setupTest(m[1] as SetupStepId, body(b));
    if (!t.ok) throw new ApiError(400, t.message);
    const s = state.setup.find((x) => x.id === m[1]);
    if (s) s.done = true;
    return { ok: true, message: "Saved." };
  }],
  ["GET", /^\/api\/overview$/, overview],
  ["GET", /^\/api\/teams$/, () => state.teams.map(computeTeam)],
  ["POST", /^\/api\/teams$/, (_m, b) => {
    const p = body<{ name: string; slug?: string; steward_name?: string; emoji?: string; color?: string }>(b);
    if (!p.name?.trim()) throw new ApiError(400, "Give the team a name.");
    const slug = p.slug || p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (state.teams.some((t) => t.slug === slug)) throw new ApiError(409, `A team called "${slug}" already exists.`);
    const t: D.MockTeam = {
      id: nid("t"), slug, name: p.name, color: p.color ?? "#3B82F6", channel: `#${slug}`, members: 0, health: 100,
      steward: { id: nid("s"), name: p.steward_name ?? "Sage", emoji: p.emoji ?? "🦊", level: 1, level_name: "Draft", paused: false, status_line: "", duties: ["ledger", "front_desk", "rhythm"] },
      counts: { open: 0, at_risk: 0, overdue: 0, pending_approvals: 0, incidents_open: 0, requests_in: 0, requests_out: 0 },
    };
    state.teams.push(t);
    state.levels[slug] = { ...state.levels.mobile, level: 1, level_name: "Draft", samples: 0, approval_rate: null, eligible_for: null, history: [] };
    return computeTeam(t);
  }],
  ["GET", /^\/api\/teams\/([\w-]+)$/, (m) => {
    const t = team(m[1]);
    return teamDetail(t);
  }],
  ...adminRoutes(),
  ["PATCH", /^\/api\/teams\/([\w-]+)\/steward$/, (m, b) => {
    const t = team(m[1]);
    const p = body<{ paused?: boolean; name?: string; emoji?: string; duties?: Duty[] }>(b);
    if (p.paused !== undefined) t.steward.paused = p.paused;
    if (p.name) t.steward.name = p.name;
    if (p.emoji) t.steward.emoji = p.emoji;
    if (p.duties) t.steward.duties = p.duties;
    audit(user.email, p.paused !== undefined ? (p.paused ? "steward.pause" : "steward.resume") : "steward.update", t.steward.name, JSON.stringify(p), t.slug);
    if (p.paused !== undefined) emit({ team_slug: t.slug, kind: "level", icon: p.paused ? "⏸️" : "▶️", text: `${user.name} ${p.paused ? "paused" : "resumed"} ${t.steward.name}.`, link: `/teams/${t.slug}` });
    return computeTeam(t).steward;
  }],
  ["GET", /^\/api\/teams\/([\w-]+)\/level$/, (m) => state.levels[team(m[1]).slug]],
  ["POST", /^\/api\/teams\/([\w-]+)\/level$/, (m, b) => {
    const t = team(m[1]);
    const { level, reason } = body<{ level: Level; reason: string }>(b);
    if (level < 0 || level > 4) throw new ApiError(400, "Level must be between L0 and L4.");
    const info = state.levels[t.slug];
    info.history.push({ at: now(), from: t.steward.level, to: level, reason: reason || "No reason given.", actor: user.name });
    t.steward.level = level;
    info.level = level;
    info.level_name = D.LEVEL_NAMES[level];
    info.eligible_for = null;
    info.samples = 0;
    info.approval_rate = null;
    audit(user.email, "level.change", t.steward.name, `→ L${level}`, t.slug);
    emit({ team_slug: t.slug, kind: "level", icon: "🎚️", text: `${user.name} moved ${t.steward.name} to L${level} ${D.LEVEL_NAMES[level]}.`, link: `/teams/${t.slug}/level` });
    return info;
  }],
  ["GET", /^\/api\/commitments$/, (_m, _b, url) => {
    const tm = url.searchParams.get("team");
    const st = url.searchParams.get("status");
    const rk = url.searchParams.get("risk");
    return state.commitments.filter(
      (c) => (!tm || c.owner_team === tm || c.requester_team === tm) && (!st || st.split(",").includes(c.status)) && (!rk || rk.split(",").includes(c.risk)),
    );
  }],
  ["POST", /^\/api\/commitments$/, (_m, b) => {
    const p = body<{ team: string; title: string; detail?: string; due_at?: string; owner_person?: string; priority?: Commitment["priority"]; requester_team?: string }>(b);
    team(p.team);
    if (!p.title?.trim()) throw new ApiError(400, "Give the commitment a title.");
    const max = Math.max(...state.commitments.map((c) => Number(c.key.slice(2))));
    const c: Commitment = {
      key: `C-${max + 1}`, title: p.title, detail: p.detail ?? "", status: "accepted", risk: "on_track", priority: p.priority ?? "normal",
      owner_team: p.team, requester_team: p.requester_team ?? null, owner_person: p.owner_person ?? null, requester_person: null,
      due_at: p.due_at ?? null, created_at: now(), updated_at: now(), source_url: null, source_kind: "web", label: "internal",
    };
    state.commitments.push(c);
    emit({ team_slug: p.team, kind: "commitment", icon: "📌", text: `${user.name} added ${c.key}: ${c.title}.`, link: `/commitments/${c.key}` });
    return c;
  }],
  ["GET", /^\/api\/commitments\/([\w-]+)$/, (m) => detail(m[1])],
  ["PATCH", /^\/api\/commitments\/([\w-]+)$/, (m, b) => {
    const c = state.commitments.find((x) => x.key === m[1]);
    if (!c) throw new ApiError(404, `There is no commitment ${m[1]}.`);
    const p = body<{ status?: Commitment["status"]; due_at?: string; owner_person?: string; priority?: Commitment["priority"]; note?: string }>(b);
    if (p.status && p.status !== c.status) {
      addEvent(c.key, user.name, "status", `Moved to ${p.status.replace("_", " ")}.`);
      c.status = p.status;
      if (!OPEN.has(p.status)) c.risk = "none";
    }
    if (p.priority) c.priority = p.priority;
    if (p.owner_person !== undefined) c.owner_person = p.owner_person;
    if (p.due_at) c.due_at = p.due_at;
    if (p.note) addEvent(c.key, user.name, "note", p.note);
    c.updated_at = now();
    return detail(c.key);
  }],
  ["GET", /^\/api\/approvals$/, (_m, _b, url) => {
    const tm = url.searchParams.get("team");
    const st = url.searchParams.get("status");
    return state.approvals.filter((a) => (!tm || a.team_slug === tm) && (!st || a.status === st));
  }],
  ["POST", /^\/api\/approvals\/(\w+)\/approve$/, (m, b) => decide(m[1], "approved", body<{ edited_preview?: string }>(b).edited_preview)],
  ["POST", /^\/api\/approvals\/(\w+)\/reject$/, (m, b) => decide(m[1], "rejected", undefined, body<{ reason?: string }>(b).reason)],
  ["GET", /^\/api\/operations$/, (_m, _b, url) => {
    const tm = url.searchParams.get("team");
    const st = url.searchParams.get("status");
    return state.operations.filter((o) => (!tm || o.team_slug === tm) && (!st || st.split(",").includes(o.status)));
  }],
  ["POST", /^\/api\/operations\/(\w+)\/resolve$/, (m, b) => {
    const o = state.operations.find((x) => x.id === m[1]);
    if (!o) throw new ApiError(404, "That operation no longer exists.");
    const { outcome } = body<{ outcome: "done" | "retry" | "cancel" }>(b);
    o.updated_at = now();
    if (outcome === "done") {
      o.status = "done";
      o.error_line = null;
    } else if (outcome === "retry") {
      o.status = "dispatching";
      o.attempts += 1;
      o.error_class = null;
      o.error_line = null;
      settleLater(o, 1200);
    } else {
      o.status = "failed";
      o.error_class = null;
      o.error_line = "Cancelled by you. Keel won't send it.";
    }
    audit(user.email, `operation.${outcome}`, o.op_id, o.summary, o.team_slug);
    return o;
  }],
  ["GET", /^\/api\/teams\/([\w-]+)\/knowledge$/, (m) => state.knowledge[team(m[1]).slug] ?? []],
  ["POST", /^\/api\/teams\/([\w-]+)\/knowledge$/, (m, b) => {
    const t = team(m[1]);
    const p = body<{ title: string; content: string; label: Label; source?: string; review_by?: string }>(b);
    if (!p.title?.trim() || !p.content?.trim()) throw new ApiError(400, "A doc needs a title and some content.");
    const d = newDoc({ title: p.title, source: p.source || "Added in Keel", label: p.label, snippet: p.content.slice(0, 180), chars: p.content.length, review_by: p.review_by || dayFrom(90) });
    contents[d.id] = p.content;
    (state.knowledge[t.slug] ??= []).unshift(d);
    emit({ team_slug: t.slug, kind: "knowledge", icon: "📚", text: `${t.steward.name} learned a new doc: ${d.title}.`, link: `/teams/${t.slug}/knowledge` });
    return d;
  }],
  ["GET", /^\/api\/teams\/([\w-]+)\/learning$/, (m) => {
    const slug = team(m[1]).slug;
    const order = (g: Gap) => (g.status === "suggested" ? 0 : g.status === "open" ? 1 : 2);
    return {
      stats: learningStats(slug),
      lessons: [...(state.learning.lessons[slug] ?? [])].sort((a, b) => Number(b.active) - Number(a.active)),
      gaps: [...(state.learning.gaps[slug] ?? [])].sort((a, b) => order(a) - order(b) || b.count - a.count),
    };
  }],
  ["POST", /^\/api\/teams\/([\w-]+)\/lessons$/, (m, b) => {
    const t = team(m[1]);
    const rule = (body<{ rule: string }>(b).rule ?? "").trim();
    if (!rule) throw new ApiError(400, "A rule needs some words.");
    const l: Lesson = { id: nid("ls"), kind: "rule", headline: rule, situation: "", before: "", after: "", note: rule, label: "internal", source: "teach", author: user.name, active: true, uses: 0, last_used_at: null, created_at: now() };
    (state.learning.lessons[t.slug] ??= []).unshift(l);
    emit({ team_slug: t.slug, kind: "learning", icon: "🧠", text: `${t.steward.name} learned a rule from ${user.name}: ${rule}`, link: `/teams/${t.slug}/learning` });
    audit(user.email, "lesson.add", l.id, rule, t.slug);
    return l;
  }],
  ["PATCH", /^\/api\/lessons\/(\w+)$/, (m, b) => {
    const l = Object.values(state.learning.lessons).flat().find((x) => x.id === m[1]);
    if (!l) throw new ApiError(404, "That lesson doesn't exist.");
    l.active = !!body<{ active: boolean }>(b).active;
    return l;
  }],
  ["POST", /^\/api\/gaps\/(\w+)\/fill$/, (m, b) => {
    const [slug, g] = findGap(m[1]);
    const p = body<{ content?: string; title?: string; label: Label }>(b);
    const content = (p.content ?? g.suggested_answer ?? "").trim();
    if (!content) throw new ApiError(400, "Write an answer first.");
    const d = newDoc({ title: p.title || g.question, source: "Answered in Keel", label: p.label, snippet: content.slice(0, 180), chars: content.length });
    contents[d.id] = content;
    (state.knowledge[slug] ??= []).unshift(d);
    Object.assign(g, { status: "filled", doc_id: d.id, closed_by: user.name, closed_at: now() });
    emit({ team_slug: slug, kind: "knowledge", icon: "📚", text: `${team(slug).steward.name} learned the answer to “${g.question}”.`, link: `/teams/${slug}/knowledge` });
    return { gap: g, doc: d };
  }],
  ["POST", /^\/api\/gaps\/(\w+)\/dismiss$/, (m) => {
    const [, g] = findGap(m[1]);
    Object.assign(g, { status: "dismissed", closed_by: user.name, closed_at: now() });
    return g;
  }],
  ["POST", /^\/api\/teams\/([\w-]+)\/ask$/, (m, b) => askAnswer(team(m[1]).slug, body<{ question: string }>(b).question ?? "")],
  ["GET", /^\/api\/teams\/([\w-]+)\/services$/, (m) => state.services[team(m[1]).slug] ?? []],
  ["POST", /^\/api\/teams\/([\w-]+)\/services$/, (m, b) => {
    const t = team(m[1]);
    const p = body<{ name: string; url: string; owner?: string }>(b);
    if (!/^https?:\/\//.test(p.url ?? "")) throw new ApiError(400, "The URL should start with http:// or https://.");
    const s: Service = { id: nid("svc"), name: p.name, url: p.url, owner: p.owner ?? null, state: "unknown", uptime_24h: null, latency_p50_ms: null, checks: [], open_incident: null, runbooks: [] };
    (state.services[t.slug] ??= []).push(s);
    return s;
  }],
  ["POST", /^\/api\/services\/(\w+)\/runbooks\/(\w+)\/run$/, (m) => {
    const [slug, s] = Object.entries(state.services).flatMap(([k, list]) => list.map((x) => [k, x] as const)).find(([, x]) => x.id === m[1]) ?? [];
    if (!s || !slug) throw new ApiError(404, "That service no longer exists.");
    const rb = s.runbooks.find((r) => r.id === m[2]);
    if (!rb) throw new ApiError(404, "That runbook no longer exists.");
    const st = team(slug).steward;
    if (st.paused) throw new ApiError(409, `${st.name} is paused. Resume it to run runbooks.`);
    if (st.level < rb.min_level) throw new ApiError(403, `This runbook needs L${rb.min_level} ${D.LEVEL_NAMES[rb.min_level]}. ${st.name} is at L${st.level} ${D.LEVEL_NAMES[st.level]}.`);
    const o = newOp({ op_id: `svc:${s.name}:${rb.id}:${state.seq}`, team_slug: slug, kind: "runbook.run", target: `svc:${s.name}:${rb.id}`, summary: `${rb.name} on ${s.name}`, status: "dispatching" });
    settleLater(o);
    emit({ team_slug: slug, kind: "operation", icon: "🛠️", text: `${st.name} is running "${rb.name}" on ${s.name}.`, link: "/operations" });
    return o;
  }],
  ["GET", /^\/api\/teams\/([\w-]+)\/briefs$/, (m) => state.briefs[team(m[1]).slug] ?? []],
  ["POST", /^\/api\/teams\/([\w-]+)\/briefs$/, (m, b) => makeBrief(team(m[1]).slug, body<{ kind: "daily" | "weekly" }>(b).kind ?? "daily")],
  ["GET", /^\/api\/teams\/([\w-]+)\/chat$/, (m) => state.chat[team(m[1]).slug] ?? []],
  ["POST", /^\/api\/teams\/([\w-]+)\/chat$/, (m, b) => {
    const slug = team(m[1]).slug;
    const msg = body<{ message: string }>(b).message ?? "";
    const list = (state.chat[slug] ??= []);
    list.push({ role: "user", text: msg, at: now() });
    const replies = chatReply(slug, msg);
    list.push(...replies);
    return replies;
  }],
  ["GET", /^\/api\/audit$/, (_m, _b, url) => {
    const tm = url.searchParams.get("team");
    return state.audit.filter((a) => !tm || a.team_slug === tm);
  }],
  ["POST", /^\/api\/checkups$/, (_m, b) => {
    const repo = (body<{ repo: string }>(b).repo ?? "").trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ApiError(400, "Use the form owner/name, like acme/payments-api.");
    const r: CheckupReport = { id: nid("ck"), repo, status: "running", error_line: null, score: null, grade: null, findings: [], stats: {}, created_at: now() };
    state.checkups.unshift(r);
    return r;
  }],
  ["GET", /^\/api\/checkups$/, () => state.checkups.map(progressCheckup)],
  ["GET", /^\/api\/checkups\/(\w+)$/, (m) => {
    const r = state.checkups.find((x) => x.id === m[1]);
    if (!r) throw new ApiError(404, "That checkup no longer exists.");
    return progressCheckup(r);
  }],
  ["GET", /^\/api\/checkups\/(\w+)\/(badge|card)\.svg$/, (m) => {
    const r = state.checkups.find((x) => x.id === m[1]);
    if (!r) throw new ApiError(404, "That checkup no longer exists.");
    if (progressCheckup(r).status !== "done") throw new ApiError(409, "That checkup hasn't finished yet.");
    return m[2] === "badge" ? S.checkupBadge(r) : S.checkupCard(r);
  }],
  ["POST", /^\/api\/promises$/, async (_m, b) => {
    const p = body<{ repo?: string; days?: number }>(b);
    const repo = (p.repo ?? "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ApiError(422, "Use the form owner/name, like vercel/next.js.");
    const days = [7, 30, 90].includes(Number(p.days)) ? Number(p.days) : 30;
    await sleep(repo.startsWith("acme/") ? 600 : 2600);
    if (/missing|404|private/.test(repo)) throw new ApiError(422, `GitHub says ${repo} doesn't exist or Keel's token can't see it.`);
    return S.promiseReport(repo, days);
  }],
  ["GET", /^\/api\/teams\/([\w-]+)\/wrapped$/, (m, _b, url) => {
    const t = team(m[1]);
    return S.wrappedFacts(t.slug, t.name, Number(url.searchParams.get("days")) || 30);
  }],
  ["GET", /^\/api\/teams\/([\w-]+)\/wrapped\/card\.svg$/, (m, _b, url) => {
    const t = team(m[1]);
    return S.wrappedCard(S.wrappedFacts(t.slug, t.name, Number(url.searchParams.get("days")) || 30));
  }],
  ["POST", /^\/api\/demo\/tick$/, () => {
    const fn = script[state.tick];
    if (!fn) return { event: null };
    state.tick += 1;
    return { event: fn() };
  }],
];

function progressCheckup(r: CheckupReport): CheckupReport {
  if (r.status !== "running" || Date.now() - Date.parse(r.created_at) < 5200) return r;
  if (/missing|404|private/.test(r.repo)) {
    r.status = "failed";
    r.error_line = `GitHub says ${r.repo} doesn't exist or Keel's token can't see it.`;
    return r;
  }
  const seed = [...r.repo].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const score = 58 + (seed % 37);
  r.status = "done";
  r.score = score;
  r.grade = score >= 90 ? "A" : score >= 80 ? "B" : score >= 70 ? "C" : score >= 60 ? "D" : "F";
  Object.assign(r, D.checkupBody(r.repo, seed));
  return r;
}

function setupTest(step: SetupStepId, b: Record<string, string>): { ok: boolean; message: string } {
  switch (step) {
    case "admin":
      if (!state.setup.find((x) => x.id === "admin")?.done && !(b.setup_code ?? "").trim()) return { ok: false, message: "Enter the setup code from the server log." };
      if (!b.email?.includes("@")) return { ok: false, message: "That email address is missing an @." };
      if ((b.password ?? "").length < 12) return { ok: false, message: "Use a password with at least 12 characters." };
      return { ok: true, message: "Looks good." };
    case "model":
      if (["anthropic", "openai", "azure_openai"].includes(b.provider) && !b.api_key) return { ok: false, message: `${b.provider === "anthropic" ? "Anthropic" : "OpenAI"} needs an API key.` };
      if (b.provider === "ollama" && !b.base_url) return { ok: false, message: "Ollama needs a base URL, like http://localhost:11434." };
      return { ok: true, message: `${b.model || "The model"} answered in 640 ms.` };
    case "slack":
      if (!b.bot_token?.startsWith("xoxb-")) return { ok: false, message: "The bot token should start with xoxb-. Copy it from OAuth & Permissions." };
      if (!b.app_token?.startsWith("xapp-")) return { ok: false, message: "The app-level token should start with xapp-. Create one under Basic Information." };
      return { ok: true, message: "Connected to the Acme workspace as @keel." };
    case "github":
      if (b.token && !/^(ghp_|github_pat_)/.test(b.token)) return { ok: false, message: "That doesn't look like a GitHub token. It should start with ghp_ or github_pat_." };
      if (!b.token && !(b.app_id && b.private_key && b.installation_id)) return { ok: false, message: "Paste a token, or fill in all three GitHub App fields." };
      return { ok: true, message: "Signed in as keel-bot. It can see 14 repos in acme." };
    case "policy":
      return { ok: true, message: `New stewards start at L${b.default_level ?? 1}. New docs default to ${b.label_default ?? "internal"}.` };
    case "team":
      if (!b.name?.trim()) return { ok: false, message: "Give the team a name." };
      return { ok: true, message: `${b.steward_name || "The steward"} is ready for ${b.name}.` };
  }
  return { ok: false, message: "Keel doesn't know that setup step." };
}

function decide(id: string, to: "approved" | "rejected", edited?: string, reason?: string): Approval {
  const a = state.approvals.find((x) => x.id === id);
  if (!a) throw new ApiError(404, "That approval no longer exists.");
  if (a.status !== "pending") throw new ApiError(409, `Someone already ${a.status} this.`);
  a.status = to;
  if (edited !== undefined) a.preview = edited;
  const st = team(a.team_slug).steward;
  let o = state.operations.find((x) => x.op_id === approvalOp[id]);
  if (!o && to === "approved") {
    o = newOp({ op_id: `${(a.commitment_key ?? "ap").toLowerCase()}:${a.kind.replace(".", "-")}`, team_slug: a.team_slug, kind: a.kind, target: a.audience.split(" ")[0], summary: a.title, status: "intent_recorded" });
  }
  if (o) {
    o.updated_at = now();
    if (to === "approved") {
      o.status = "dispatching";
      o.attempts = Math.max(1, o.attempts);
      settleLater(o);
    } else o.status = "rejected";
  }
  if (to === "approved" && state.levels[a.team_slug]) state.levels[a.team_slug].samples += 1;
  const lesson = (kind: Lesson["kind"], f: Partial<Lesson>) => {
    const base = { situation: a.title, before: a.preview, after: "", note: "", ...f };
    (state.learning.lessons[a.team_slug] ??= []).unshift({ id: nid("ls"), kind, label: a.label, source: `approval:${a.id}`, author: user.name, active: true, uses: 0, last_used_at: null, created_at: now(), ...base, headline: D.lessonHeadline({ kind, ...base }) });
    emit({ team_slug: a.team_slug, kind: "learning", icon: "🧠", text: `${st.name} learned from ${user.name}: ${D.lessonHeadline({ kind, ...base })}`, link: `/teams/${a.team_slug}/learning` });
  };
  if (to === "approved" && edited !== undefined) lesson("reply", { after: edited });
  if (to === "rejected" && reason?.trim()) lesson("reply", { note: reason.trim() });
  audit(user.email, `approval.${to === "approved" ? "approve" : "reject"}`, id, edited !== undefined ? "Approved with edits" : reason ?? (to === "approved" ? "Approved unchanged" : "Rejected"), a.team_slug);
  emit({ team_slug: a.team_slug, kind: "approval", icon: to === "approved" ? "👍" : "✋", text: `${user.name} ${to} "${a.title}". ${to === "approved" ? `${st.name} is sending it.` : `${st.name} won't send it.`}`, link: a.commitment_key ? `/commitments/${a.commitment_key}` : "/approvals" });
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

export const mockTransport: Transport = async (method, path, b) => {
  const url = new URL(path, location.origin);
  await sleep(120 + Math.random() * 260);
  for (const [m, re, h] of routes) {
    if (m !== method) continue;
    const match = url.pathname.match(re);
    if (match) {
      const open = /^\/api\/(me|auth|setup|invite\/)/.test(url.pathname);
      if (!open && localStorage.getItem(SIGNED_OUT_KEY)) throw new ApiError(401, "Sign in to continue.");
      return clone(await h(match, b, url));
    }
  }
  throw new ApiError(404, `The mock API has no ${method} ${url.pathname}.`);
};

export const mockStream: StreamSource = (onItem, onState) => {
  listeners.add(onItem);
  onState?.(true);
  const timer = setInterval(() => {
    const [slug, kind, icon, text, link] = ambient[ambientIdx++ % ambient.length];
    emit({ team_slug: slug, kind, icon, text: text(team(slug).steward.name), link });
  }, 6000);
  return () => {
    clearInterval(timer);
    listeners.delete(onItem);
  };
};

export function installMock() {
  installTransport(mockTransport, mockStream);
}
