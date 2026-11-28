import type {
  ActivityItem,
  Approval,
  AskResult,
  AuditEntry,
  Brief,
  ChatMessage,
  CheckupReport,
  Commitment,
  CommitmentDetail,
  CommitmentFilters,
  CreateCommitmentBody,
  CreateTeamBody,
  CreateInviteBody,
  Gap,
  Invite,
  InviteInfo,
  KnowledgeDoc,
  KnowledgeDocFull,
  KnowledgeSource,
  Label,
  LearningInfo,
  Lesson,
  Level,
  LevelInfo,
  LoginBody,
  Me,
  Member,
  PatchKnowledgeBody,
  PatchTeamBody,
  Person,
  OrgRole,
  TeamRole,
  OkMessage,
  PromiseReport,
  Operation,
  Overview,
  PatchCommitmentBody,
  PatchStewardBody,
  ResolveOutcome,
  Service,
  SetupInfo,
  SetupStepId,
  StewardSummary,
  TeamDetail,
  TeamSummary,
  WrappedFacts,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
    this.name = "ApiError";
  }
}

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** A transport turns (method, path, body) into parsed JSON or throws ApiError. */
export type Transport = (method: Method, path: string, body?: unknown) => Promise<unknown>;

/** Subscribe to the activity stream. Returns an unsubscribe function. */
export type StreamSource = (onItem: (item: ActivityItem) => void, onState?: (live: boolean) => void) => () => void;

const fetchTransport: Transport = async (method, path, body) => {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const detail =
      data && typeof data === "object" && "detail" in data && typeof (data as { detail: unknown }).detail === "string"
        ? (data as { detail: string }).detail
        : `The server answered ${res.status} without saying why.`;
    throw new ApiError(res.status, detail);
  }
  return data;
};

const eventSourceStream: StreamSource = (onItem, onState) => {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    es = new EventSource("/api/stream", { withCredentials: true });
    es.onopen = () => onState?.(true);
    es.onmessage = (e) => {
      try {
        onItem(JSON.parse(e.data) as ActivityItem);
      } catch {
        /* ignore keepalives / malformed lines */
      }
    };
    es.onerror = () => {
      onState?.(false);
      es?.close();
      if (!closed) retry = setTimeout(open, 5000);
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
};

let transport: Transport = fetchTransport;
let stream: StreamSource = eventSourceStream;

export function installTransport(t: Transport, s?: StreamSource) {
  transport = t;
  if (s) stream = s;
}

export function subscribeStream(onItem: (item: ActivityItem) => void, onState?: (live: boolean) => void) {
  return stream(onItem, onState);
}

function q(params: Record<string, string | undefined | null>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const get = <T,>(path: string) => transport("GET", path) as Promise<T>;
const post = <T,>(path: string, body?: unknown) => transport("POST", path, body ?? {}) as Promise<T>;
const patch = <T,>(path: string, body: unknown) => transport("PATCH", path, body) as Promise<T>;
const del = <T,>(path: string) => transport("DELETE", path) as Promise<T>;
const enc = encodeURIComponent;

export const api = {
  me: () => get<Me>("/api/me"),
  login: (body: LoginBody) => post<Me>("/api/auth/login", body),
  logout: () => post<{ ok: boolean }>("/api/auth/logout"),
  ssoUrl: "/api/auth/sso",

  setup: () => get<SetupInfo>("/api/setup"),
  saveSetup: (step: SetupStepId, body: Record<string, unknown>) => post<OkMessage>(`/api/setup/${step}`, body),
  testSetup: (step: SetupStepId, body: Record<string, unknown>) => post<OkMessage>(`/api/setup/${step}/test`, body),

  overview: () => get<Overview>("/api/overview"),
  teams: () => get<TeamSummary[]>("/api/teams"),
  createTeam: (body: CreateTeamBody) => post<TeamSummary>("/api/teams", body),
  team: (slug: string) => get<TeamDetail>(`/api/teams/${enc(slug)}`),
  patchTeam: (slug: string, body: PatchTeamBody) => patch<TeamDetail>(`/api/teams/${enc(slug)}`, body),
  deleteTeam: (slug: string) => del<OkMessage>(`/api/teams/${enc(slug)}${q({ confirm: slug })}`),
  members: (slug: string) => get<Member[]>(`/api/teams/${enc(slug)}/members`),
  addMember: (slug: string, body: { email: string; role: TeamRole }) => post<Member>(`/api/teams/${enc(slug)}/members`, body),
  patchMember: (slug: string, userId: string, role: TeamRole) => patch<Member>(`/api/teams/${enc(slug)}/members/${enc(userId)}`, { role }),
  removeMember: (slug: string, userId: string) => del<OkMessage>(`/api/teams/${enc(slug)}/members/${enc(userId)}`),

  people: () => get<Person[]>("/api/people"),
  patchPerson: (id: string, body: { role?: OrgRole; disabled?: boolean }) => patch<Person>(`/api/people/${enc(id)}`, body),
  removePerson: (id: string) => del<OkMessage>(`/api/people/${enc(id)}`),
  invites: () => get<Invite[]>("/api/invites"),
  createInvite: (body: CreateInviteBody) => post<{ invite: Invite; url: string }>("/api/invites", body),
  revokeInvite: (id: string) => del<OkMessage>(`/api/invites/${enc(id)}`),
  invite: (token: string) => get<InviteInfo>(`/api/invite/${enc(token)}`),
  acceptInvite: (token: string, body: { name: string; password: string }) => post<OkMessage>(`/api/invite/${enc(token)}`, body),
  patchSteward: (slug: string, body: PatchStewardBody) => patch<StewardSummary>(`/api/teams/${enc(slug)}/steward`, body),
  level: (slug: string) => get<LevelInfo>(`/api/teams/${enc(slug)}/level`),
  setLevel: (slug: string, level: Level, reason: string) => post<LevelInfo>(`/api/teams/${enc(slug)}/level`, { level, reason }),

  commitments: (f: CommitmentFilters = {}) => get<Commitment[]>(`/api/commitments${q({ ...f })}`),
  createCommitment: (body: CreateCommitmentBody) => post<Commitment>("/api/commitments", body),
  commitment: (key: string) => get<CommitmentDetail>(`/api/commitments/${enc(key)}`),
  patchCommitment: (key: string, body: PatchCommitmentBody) => patch<CommitmentDetail>(`/api/commitments/${enc(key)}`, body),

  approvals: (f: { team?: string; status?: string } = { status: "pending" }) => get<Approval[]>(`/api/approvals${q(f)}`),
  approve: (id: string, edited_preview?: string) =>
    post<Approval>(`/api/approvals/${enc(id)}/approve`, edited_preview !== undefined ? { edited_preview } : {}),
  reject: (id: string, reason?: string) => post<Approval>(`/api/approvals/${enc(id)}/reject`, reason ? { reason } : {}),

  operations: (f: { team?: string; status?: string } = {}) => get<Operation[]>(`/api/operations${q(f)}`),
  resolveOperation: (id: string, outcome: ResolveOutcome) => post<Operation>(`/api/operations/${enc(id)}/resolve`, { outcome }),

  knowledge: (slug: string) => get<KnowledgeDoc[]>(`/api/teams/${enc(slug)}/knowledge`),
  addKnowledge: (slug: string, body: { title: string; content: string; label: Label; source?: string; review_by?: string }) =>
    post<KnowledgeDoc>(`/api/teams/${enc(slug)}/knowledge`, body),
  knowledgeDoc: (slug: string, id: string) => get<KnowledgeDocFull>(`/api/teams/${enc(slug)}/knowledge/${enc(id)}`),
  patchKnowledge: (slug: string, id: string, body: PatchKnowledgeBody) => patch<KnowledgeDoc>(`/api/teams/${enc(slug)}/knowledge/${enc(id)}`, body),
  deleteKnowledge: (slug: string, id: string) => del<OkMessage>(`/api/teams/${enc(slug)}/knowledge/${enc(id)}`),
  reviewedKnowledge: (slug: string, id: string) => post<KnowledgeDoc>(`/api/teams/${enc(slug)}/knowledge/${enc(id)}/reviewed`),
  knowledgeSources: (slug: string) => get<KnowledgeSource[]>(`/api/teams/${enc(slug)}/knowledge-sources`),
  addKnowledgeSource: (slug: string, body: { kind: KnowledgeSource["kind"]; target: string; label: Label }) =>
    post<KnowledgeSource>(`/api/teams/${enc(slug)}/knowledge-sources`, body),
  syncKnowledgeSource: (slug: string, id: string) => post<KnowledgeSource>(`/api/teams/${enc(slug)}/knowledge-sources/${enc(id)}/sync`),
  removeKnowledgeSource: (slug: string, id: string) => del<OkMessage>(`/api/teams/${enc(slug)}/knowledge-sources/${enc(id)}`),
  learning: (slug: string) => get<LearningInfo>(`/api/teams/${enc(slug)}/learning`),
  teach: (slug: string, rule: string) => post<Lesson>(`/api/teams/${enc(slug)}/lessons`, { rule }),
  setLessonActive: (id: string, active: boolean) => patch<Lesson>(`/api/lessons/${enc(id)}`, { active }),
  fillGap: (id: string, body: { content?: string; title?: string; label: Label }) =>
    post<{ gap: Gap; doc: KnowledgeDoc }>(`/api/gaps/${enc(id)}/fill`, body),
  dismissGap: (id: string) => post<Gap>(`/api/gaps/${enc(id)}/dismiss`),
  ask: (slug: string, question: string) => post<AskResult>(`/api/teams/${enc(slug)}/ask`, { question }),

  services: (slug: string) => get<Service[]>(`/api/teams/${enc(slug)}/services`),
  addService: (slug: string, body: { name: string; url: string; owner?: string }) =>
    post<Service>(`/api/teams/${enc(slug)}/services`, body),
  runRunbook: (serviceId: string, runbookId: string) =>
    post<Operation>(`/api/services/${enc(serviceId)}/runbooks/${enc(runbookId)}/run`),

  briefs: (slug: string) => get<Brief[]>(`/api/teams/${enc(slug)}/briefs`),
  createBrief: (slug: string, kind: "daily" | "weekly") => post<Brief>(`/api/teams/${enc(slug)}/briefs`, { kind }),

  chat: (slug: string) => get<ChatMessage[]>(`/api/teams/${enc(slug)}/chat`),
  sendChat: (slug: string, message: string) => post<ChatMessage[]>(`/api/teams/${enc(slug)}/chat`, { message }),

  audit: (team?: string) => get<AuditEntry[]>(`/api/audit${q({ team })}`),
  auditExportUrl: "/api/audit/export?format=csv",

  startCheckup: (repo: string) => post<CheckupReport>("/api/checkups", { repo }),
  checkup: (id: string) => get<CheckupReport>(`/api/checkups/${enc(id)}`),
  checkups: () => get<CheckupReport[]>("/api/checkups"),
  checkupBadge: (id: string) => get<string>(`/api/checkups/${enc(id)}/badge.svg`),
  checkupCard: (id: string) => get<string>(`/api/checkups/${enc(id)}/card.svg`),

  scanPromises: (repo: string, days: number) => post<PromiseReport>("/api/promises", { repo, days }),

  wrapped: (slug: string, days = 30) => get<WrappedFacts>(`/api/teams/${enc(slug)}/wrapped?days=${days}`),
  wrappedCard: (slug: string, days = 30) => get<string>(`/api/teams/${enc(slug)}/wrapped/card.svg?days=${days}`),

  demoTick: () => post<{ event: ActivityItem | null }>("/api/demo/tick"),
};

export function errorLine(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return "Keel's server didn't answer. Check that it is running.";
  if (e instanceof Error && e.message) return e.message;
  return "The request failed and the server gave no reason.";
}
