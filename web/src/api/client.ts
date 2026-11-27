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
  KnowledgeDoc,
  Label,
  Level,
  LevelInfo,
  LoginBody,
  Me,
  OkMessage,
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
  addKnowledge: (slug: string, body: { title: string; content: string; label: Label; source?: string }) =>
    post<KnowledgeDoc>(`/api/teams/${enc(slug)}/knowledge`, body),
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

  startCheckup: (repo: string) => post<CheckupReport>("/api/checkups", { repo }),
  checkup: (id: string) => get<CheckupReport>(`/api/checkups/${enc(id)}`),
  checkups: () => get<CheckupReport[]>("/api/checkups"),

  demoTick: () => post<{ event: ActivityItem | null }>("/api/demo/tick"),
};

export function errorLine(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return "Keel's server didn't answer. Check that it is running.";
  if (e instanceof Error && e.message) return e.message;
  return "The request failed and the server gave no reason.";
}
