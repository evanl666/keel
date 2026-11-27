// Mirrors keel/docs/api.md (v0.1). Keep in sync with the contract.

export type Level = 0 | 1 | 2 | 3 | 4;
export type Label = "public" | "internal" | "confidential" | "restricted";
export type Role = "org_admin" | "team_admin" | "member";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatar_url: string | null;
}

export interface Me {
  user: User | null;
  org: { id: string; name: string } | null;
  demo: boolean;
  setup_complete: boolean;
  sso_enabled: boolean;
  version: string;
}

export type Duty = "ledger" | "front_desk" | "rhythm" | "services" | "knowledge" | "chores";

export interface StewardSummary {
  id: string;
  name: string;
  emoji: string;
  level: Level;
  level_name: string;
  paused: boolean;
  status_line: string;
  duties: Duty[];
}

export interface TeamCounts {
  open: number;
  at_risk: number;
  overdue: number;
  pending_approvals: number;
  incidents_open: number;
  requests_in: number;
  requests_out: number;
}

export interface TeamSummary {
  id: string;
  slug: string;
  name: string;
  color: string;
  steward: StewardSummary;
  health: number;
  counts: TeamCounts;
}

export interface CrossTeamEdge {
  from_team: string;
  to_team: string;
  open: number;
  at_risk: number;
}

export type ActivityKind =
  | "commitment"
  | "approval"
  | "operation"
  | "service"
  | "brief"
  | "knowledge"
  | "level"
  | "inbox"
  | "chat"
  | "learning"
  | "promotion";

export interface ActivityItem {
  id: string;
  at: string;
  team_slug: string | null;
  kind: ActivityKind;
  icon: string;
  text: string;
  link: string | null;
}

export interface OverviewTotals {
  open: number;
  done_7d: number;
  at_risk: number;
  overdue: number;
  pending_approvals: number;
  incidents_open: number;
  ops_needs_review: number;
}

export interface Overview {
  org: { id: string; name: string };
  teams: TeamSummary[];
  cross_team: CrossTeamEdge[];
  totals: OverviewTotals;
  activity: ActivityItem[];
}

export type CommitmentStatus =
  | "proposed"
  | "accepted"
  | "in_progress"
  | "blocked"
  | "done"
  | "dropped"
  | "declined";
export type Risk = "on_track" | "at_risk" | "overdue" | "none";
export type Priority = "low" | "normal" | "high" | "urgent";

export interface Commitment {
  key: string;
  title: string;
  detail: string;
  status: CommitmentStatus;
  risk: Risk;
  priority: Priority;
  owner_team: string;
  requester_team: string | null;
  owner_person: string | null;
  requester_person: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  source_url: string | null;
  source_kind: "slack" | "github" | "web" | "steward" | "service" | "demo";
  label: Label;
}

export interface CommitmentEvent {
  id: string;
  at: string;
  actor: string;
  kind: string;
  text: string;
}

export interface CommitmentDetail extends Commitment {
  events: CommitmentEvent[];
  operations: Operation[];
}

export type OpStatus =
  | "awaiting_approval"
  | "intent_recorded"
  | "dispatching"
  | "acked"
  | "unknown"
  | "reconciled"
  | "needs_review"
  | "done"
  | "failed"
  | "rejected";

export interface Operation {
  id: string;
  op_id: string;
  team_slug: string;
  kind: string;
  target: string;
  summary: string;
  status: OpStatus;
  attempts: number;
  error_class: string | null;
  error_line: string | null;
  remote_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: string;
  team_slug: string;
  created_at: string;
  kind: string;
  title: string;
  preview: string;
  reason: string;
  label: Label;
  audience: string;
  commitment_key: string | null;
  status: "pending" | "approved" | "rejected";
}

export interface LevelInfo {
  level: Level;
  level_name: string;
  levels: { level: Level; name: string; can: string }[];
  samples: number;
  approval_rate: number | null;
  min_samples: number;
  min_approval_rate: number;
  eligible_for: Level | null;
  history: { at: string; from: Level; to: Level; reason: string; actor: string }[];
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  source: string;
  label: Label;
  updated_at: string;
  snippet: string;
  chars: number;
}

export interface AskSource {
  title: string;
  source: string;
  label: Label;
}

export interface AskResult {
  answer: string;
  label: Label;
  sources: AskSource[];
  withheld: number;
  /** True when the notes didn't cover it and the question was logged for the team. */
  open_question?: boolean;
}

export type LessonKind = "reply" | "triage" | "rule";

/** Something the steward learned from a correction or was taught outright. */
export interface Lesson {
  id: string;
  kind: LessonKind;
  headline: string;
  situation: string;
  before: string;
  after: string;
  note: string;
  label: Label;
  source: string;
  author: string;
  active: boolean;
  uses: number;
  last_used_at: string | null;
  created_at: string;
}

export type GapStatus = "open" | "suggested" | "filled" | "dismissed";

/** A question the notes couldn't answer. */
export interface Gap {
  id: string;
  question: string;
  asked_by: string;
  count: number;
  status: GapStatus;
  suggested_answer: string | null;
  suggested_by: string | null;
  doc_id: string | null;
  closed_by: string | null;
  created_at: string;
  last_asked_at: string;
  closed_at: string | null;
}

export interface LearningStats {
  lessons_active: number;
  rules: number;
  learned_this_week: number;
  used_this_week: number;
  open_questions: number;
  suggested_answers: number;
  filled_total: number;
  /** Share of drafts sent without edits, last 30 days; null when there were none. */
  unedited_rate: number | null;
  unedited_rate_before: number | null;
}

export interface LearningInfo {
  stats: LearningStats;
  lessons: Lesson[];
  gaps: Gap[];
}

export interface ServiceCheck {
  at: string;
  ok: boolean;
  latency_ms: number | null;
  status_code: number | null;
}

export interface Runbook {
  id: string;
  name: string;
  min_level: Level;
}

export interface Service {
  id: string;
  name: string;
  url: string;
  owner: string | null;
  state: "up" | "degraded" | "down" | "unknown";
  uptime_24h: number | null;
  latency_p50_ms: number | null;
  checks: ServiceCheck[];
  open_incident: { id: string; opened_at: string; summary: string; commitment_key: string | null } | null;
  runbooks: Runbook[];
}

export interface Brief {
  id: string;
  team_slug: string;
  kind: "daily" | "weekly" | "checkup";
  created_at: string;
  title: string;
  markdown: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail: string;
  team_slug: string | null;
}

export interface ChatMessage {
  role: "user" | "steward";
  text: string;
  at: string;
  sources?: AskResult["sources"];
  actions?: { kind: string; text: string; link: string | null }[];
}

export type SetupStepId = "admin" | "model" | "slack" | "github" | "policy" | "team";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  done: boolean;
  optional: boolean;
  detail: string;
}

export interface SetupInfo {
  steps: SetupStep[];
  slack_manifest_url: string;
}

export interface CheckupFinding {
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  url: string | null;
}

export interface CheckupReport {
  id: string;
  repo: string;
  status: "running" | "done" | "failed";
  error_line: string | null;
  score: number | null;
  grade: string | null;
  findings: CheckupFinding[];
  stats: Record<string, number | string>;
  created_at: string;
}

export type TeamDetail = TeamSummary & { today: Brief | null; activity: ActivityItem[] };

export interface OkMessage {
  ok: boolean;
  message: string;
}

// Request bodies
export interface LoginBody {
  email: string;
  password: string;
}
export interface CreateTeamBody {
  name: string;
  slug?: string;
  steward_name?: string;
  emoji?: string;
  color?: string;
}
export interface PatchStewardBody {
  paused?: boolean;
  name?: string;
  emoji?: string;
  duties?: Duty[];
}
export interface CreateCommitmentBody {
  team: string;
  title: string;
  detail?: string;
  due_at?: string;
  owner_person?: string;
  priority?: Priority;
  requester_team?: string;
}
export interface PatchCommitmentBody {
  status?: CommitmentStatus;
  due_at?: string;
  owner_person?: string;
  priority?: Priority;
  note?: string;
}
export interface CommitmentFilters {
  team?: string;
  status?: string;
  risk?: string;
}
export type ResolveOutcome = "done" | "retry" | "cancel";

// Promise archaeology (POST /api/promises)
export type PromiseStatus = "kept" | "overdue" | "quiet" | "dropped" | "follow_up" | "open";

export interface FoundPromise {
  who: string;
  quote: string;
  said_at: string;
  url: string;
  number: number;
  thread_title: string;
  is_pr: boolean;
  what: string;
  due: string | null;
  deferred: boolean;
  status: PromiseStatus;
  resolved_at: string | null;
  days_to_keep: number | null;
  age_days: number;
}

export interface PromiseStats extends Record<PromiseStatus, number> {
  promises: number;
  judged: number;
  kept_rate: number | null;
  median_days_to_keep: number | null;
  top_promisers: { who: string; made: number; kept: number }[];
  oldest_unkept: FoundPromise | null;
  fastest_kept: FoundPromise | null;
}

export interface PromiseReport {
  repo: string;
  days: number;
  scanned_comments: number;
  checked_threads: number;
  promises: FoundPromise[];
  used_model: boolean;
  stats: PromiseStats;
  not_checked: string[];
  /** True for private or internal repos: share cards then leave comment text out. */
  private: boolean;
  badge_svg: string;
  card_svg: string;
  markdown: string;
}

// Team Wrapped (GET /api/teams/{slug}/wrapped)
export interface WrappedFacts {
  team: string;
  days: number;
  from: string;
  to: string;
  made: number;
  kept: number;
  on_time: number;
  on_time_rate: number | null;
  dropped: number;
  overdue_now: number;
  longest_on_time_streak: number;
  helped_other_teams: number;
  fastest: { key: string; title: string; hours: number } | null;
  best_partner: { team: string; count: number } | null;
  top_closers: { who: string; kept: number }[];
  busiest_day: string | null;
  oldest_open: { key: string; title: string; days: number } | null;
  persona: { name: string; line: string };
  headline: string;
}
