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
  services: (slug: string) => ["services", slug] as const,
  briefs: (slug: string) => ["briefs", slug] as const,
  chat: (slug: string) => ["chat", slug] as const,
  audit: (team?: string) => ["audit", team ?? null] as const,
  checkups: ["checkups"] as const,
  checkup: (id: string) => ["checkup", id] as const,
  setup: ["setup"] as const,
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
export const useSetup = () => useQuery({ queryKey: qk.setup, queryFn: api.setup });

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
