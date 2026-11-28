import { useMutation, useQueries, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "./client";
import type { CommitmentFilters, Duty, Level, PatchStewardBody, ResolveOutcome } from "./types";

export const qk = {
  me: ["me"] as const,
  overview: ["overview"] as const,
  teams: ["teams"] as const,
  team: (slug: string) => ["team", slug] as const,
  level: (slug: string) => ["level", slug] as const,
  commitments: (f: CommitmentFilters = {}) => ["commitments", f] as const,
  commitment: (key: string) => ["commitment", key] as const,
  approvals: (team?: string) => ["approvals", team ?? null] as const,
  operations: (team?: string) => ["operations", team ?? null] as const,
  knowledge: (slug: string) => ["knowledge", slug] as const,
  learning: (slug: string) => ["learning", slug] as const,
  services: (slug: string) => ["services", slug] as const,
  briefs: (slug: string) => ["briefs", slug] as const,
  chat: (slug: string) => ["chat", slug] as const,
  audit: (team?: string) => ["audit", team ?? null] as const,
  checkups: ["checkups"] as const,
  checkup: (id: string) => ["checkup", id] as const,
  setup: ["setup"] as const,
  people: ["people"] as const,
  invites: ["invites"] as const,
  invite: (token: string) => ["invite", token] as const,
  members: (slug: string) => ["members", slug] as const,
  knowledgeDoc: (slug: string, id: string) => ["knowledge-doc", slug, id] as const,
  knowledgeSources: (slug: string) => ["knowledge-sources", slug] as const,
  checkupSvg: (id: string, kind: "badge" | "card") => ["checkup-svg", id, kind] as const,
  promises: (repo: string, days: number) => ["promises", repo, days] as const,
  wrapped: (slug: string, days: number) => ["wrapped", slug, days] as const,
  wrappedCard: (slug: string, days: number) => ["wrapped-card", slug, days] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: api.me, staleTime: 60_000 });
export const useOverview = () => useQuery({ queryKey: qk.overview, queryFn: api.overview, refetchInterval: 30_000 });
export const useTeams = () => useQuery({ queryKey: qk.teams, queryFn: api.teams, refetchInterval: 30_000 });
export const useTeam = (slug: string) => useQuery({ queryKey: qk.team(slug), queryFn: () => api.team(slug) });
export const useLevel = (slug: string) => useQuery({ queryKey: qk.level(slug), queryFn: () => api.level(slug) });
export const useCommitments = (f: CommitmentFilters = {}) =>
  useQuery({ queryKey: qk.commitments(f), queryFn: () => api.commitments(f) });
export const useCommitment = (key: string) => useQuery({ queryKey: qk.commitment(key), queryFn: () => api.commitment(key) });
export const useApprovals = (team?: string) =>
  useQuery({ queryKey: qk.approvals(team), queryFn: () => api.approvals({ team, status: "pending" }), refetchInterval: 20_000 });
export const useOperations = (team?: string) =>
  useQuery({ queryKey: qk.operations(team), queryFn: () => api.operations({ team }), refetchInterval: 4_000 });
export const useKnowledge = (slug: string) => useQuery({ queryKey: qk.knowledge(slug), queryFn: () => api.knowledge(slug) });
export const useLearning = (slug: string) =>
  useQuery({ queryKey: qk.learning(slug), queryFn: () => api.learning(slug), refetchInterval: 30_000 });
export const useServices = (slug: string) =>
  useQuery({ queryKey: qk.services(slug), queryFn: () => api.services(slug), refetchInterval: 30_000 });
export const useAllServices = (slugs: string[]) =>
  useQueries({
    queries: slugs.map((s) => ({ queryKey: qk.services(s), queryFn: () => api.services(s), refetchInterval: 30_000 })),
  });
export const useBriefs = (slug: string) => useQuery({ queryKey: qk.briefs(slug), queryFn: () => api.briefs(slug) });
export const useChat = (slug: string) => useQuery({ queryKey: qk.chat(slug), queryFn: () => api.chat(slug) });
export const useAudit = (team?: string) => useQuery({ queryKey: qk.audit(team), queryFn: () => api.audit(team) });
export const useCheckups = () => useQuery({ queryKey: qk.checkups, queryFn: api.checkups });
export const useCheckup = (id: string | null) =>
  useQuery({
    queryKey: qk.checkup(id ?? ""),
    queryFn: () => api.checkup(id!),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1200 : false),
  });
export const useCheckupSvg = (id: string, kind: "badge" | "card", enabled = true) =>
  useQuery({
    queryKey: qk.checkupSvg(id, kind),
    queryFn: () => (kind === "badge" ? api.checkupBadge(id) : api.checkupCard(id)),
    enabled,
    staleTime: 5 * 60_000,
  });
/** A promise scan can take half a minute with a model, so a finished one is kept for the session. */
export const usePromiseScan = (repo: string | null, days: number) =>
  useQuery({
    queryKey: qk.promises(repo ?? "", days),
    queryFn: () => api.scanPromises(repo!, days),
    enabled: !!repo,
    staleTime: Infinity,
    gcTime: 60 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
export const useWrapped = (slug: string, days = 30, enabled = true) =>
  useQuery({ queryKey: qk.wrapped(slug, days), queryFn: () => api.wrapped(slug, days), enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: false });
export const useWrappedCard = (slug: string, days = 30, enabled = true) =>
  useQuery({ queryKey: qk.wrappedCard(slug, days), queryFn: () => api.wrappedCard(slug, days), enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: false });
export const useSetup = () => useQuery({ queryKey: qk.setup, queryFn: api.setup });
export const usePeople = () => useQuery({ queryKey: qk.people, queryFn: api.people });
export const useInvites = () => useQuery({ queryKey: qk.invites, queryFn: api.invites });
export const useInviteInfo = (token: string) => useQuery({ queryKey: qk.invite(token), queryFn: () => api.invite(token), retry: false });
export const useMembers = (slug: string) => useQuery({ queryKey: qk.members(slug), queryFn: () => api.members(slug) });
export const useKnowledgeDoc = (slug: string, id: string | null) =>
  useQuery({ queryKey: qk.knowledgeDoc(slug, id ?? ""), queryFn: () => api.knowledgeDoc(slug, id!), enabled: !!id });
export const useKnowledgeSources = (slug: string) =>
  useQuery({
    queryKey: qk.knowledgeSources(slug),
    queryFn: () => api.knowledgeSources(slug),
    refetchInterval: (q) => (q.state.data?.some((s) => s.status === "pending") ? 1500 : false),
  });

/** Invalidate queries whose key starts with one of these names. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...names: string[]) => qc.invalidateQueries({ predicate: (q) => names.includes(q.queryKey[0] as string) });
}

/** Invalidate everything that summarises state; cheap enough for this app's size. */
export function useRefreshAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ predicate: (q) => (q.queryKey as QueryKey)[0] !== "me" });
}

export function usePatchSteward(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchStewardBody) => api.patchSteward(slug, body),
    onSettled: () => qc.invalidateQueries({ predicate: (q) => ["team", "teams", "overview", "audit"].includes(q.queryKey[0] as string) }),
  });
}

export function useSetLevel(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ level, reason }: { level: Level; reason: string }) => api.setLevel(slug, level, reason),
    onSuccess: (info) => {
      qc.setQueryData(qk.level(slug), info);
      qc.invalidateQueries();
    },
  });
}

export function useResolveOperation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, outcome }: { id: string; outcome: ResolveOutcome }) => api.resolveOperation(id, outcome),
    onSettled: () => qc.invalidateQueries({ predicate: (q) => ["operations", "overview", "commitment", "teams", "audit"].includes(q.queryKey[0] as string) }),
  });
}

export type { Duty };
