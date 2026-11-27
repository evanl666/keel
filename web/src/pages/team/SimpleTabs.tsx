import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, errorLine } from "../../api/client";
import { useCommitments, useServices } from "../../api/hooks";
import type { Priority, TeamDetail } from "../../api/types";
import { Button, Card, EmptyState, ErrorLine, Input, Segmented, Select, Skeleton, SkeletonRows } from "../../components/ui";
import { useTeamMap } from "../../components/keel";
import { CommitmentList } from "../../components/Commitments";
import { ServiceCard } from "../../components/ServiceCard";
import { useToast } from "../../components/toast";

type Scope = "owned" | "asked" | "all";

export function LedgerTab({ t }: { t: TeamDetail }) {
  const { data, isLoading } = useCommitments();
  const teams = useTeamMap();
  const [scope, setScope] = useState<Scope>("owned");
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState<Priority>("normal");
  const qc = useQueryClient();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () => api.createCommitment({ team: t.slug, title: title.trim(), priority, due_at: dueAt ? new Date(dueAt + "T17:00:00").toISOString() : undefined }),
    onSuccess: (c) => {
      setTitle("");
      setDueAt("");
      toast({ title: `${c.key} added to the ledger`, line: c.title, icon: "📒" });
      qc.invalidateQueries({ predicate: (q) => ["commitments", "team", "teams", "overview"].includes(q.queryKey[0] as string) });
    },
  });
  const owned = useMemo(() => (data ?? []).filter((c) => c.owner_team === t.slug), [data, t.slug]);
  const asked = useMemo(() => (data ?? []).filter((c) => c.requester_team === t.slug && c.owner_team !== t.slug), [data, t.slug]);
  const items = scope === "owned" ? owned : scope === "asked" ? asked : [...owned, ...asked];

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-4">
        <Segmented
          value={scope}
          onChange={setScope}
          options={[
            { value: "owned", label: `${t.name} owns`, count: owned.length },
            { value: "asked", label: "Asked of others", count: asked.length },
            { value: "all", label: "All", count: owned.length + asked.length },
          ]}
        />
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (title.trim()) add.mutate();
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`New promise ${t.name} makes…`} className="h-8 w-[280px] text-[13px]" />
          <Input type="date" value={dueAt} onChange={(e) => setDueAt(e.target.value)} className="h-8 w-[140px] text-[13px]" aria-label="Due date" />
          <Select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className="h-8 w-[110px] text-[13px]" aria-label="Priority">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </Select>
          <Button type="submit" size="md" icon={<Plus className="size-3.5" />} loading={add.isPending} disabled={!title.trim()}>
            Add
          </Button>
        </form>
      </div>
      {add.error && <ErrorLine error={errorLine(add.error)} className="mb-3" />}
      {isLoading ? (
        <SkeletonRows rows={8} />
      ) : items.length ? (
        <CommitmentList items={items} teams={teams} />
      ) : (
        <Card>
          <EmptyState icon="📒" title="Nothing in the ledger" line={`${t.steward.name} adds promises it hears in Slack and GitHub. You can add one above.`} />
        </Card>
      )}
    </div>
  );
}

export function ServicesTab({ t }: { t: TeamDetail }) {
  const { data, isLoading } = useServices(t.slug);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const qc = useQueryClient();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () => api.addService(t.slug, { name: name.trim(), url: url.trim() }),
    onSuccess: (s) => {
      setName("");
      setUrl("");
      setOpen(false);
      toast({ title: `${t.steward.name} is watching ${s.name}`, line: "First check runs within a minute.", icon: "🩺" });
      qc.invalidateQueries({ predicate: (q) => ["services", "team", "teams"].includes(q.queryKey[0] as string) });
    },
  });
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-[13px] text-muted">
          {t.steward.name} checks each service every minute and opens an incident after 3 failures in a row.
        </div>
        <Button size="md" icon={<Plus className="size-3.5" />} onClick={() => setOpen((o) => !o)}>
          Watch a service
        </Button>
      </div>
      {open && (
        <Card className="p-4 mb-4">
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, like checkout-api" className="w-[220px]" />
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/healthz" className="flex-1 font-mono text-[13px]" />
            <Button type="submit" variant="primary" loading={add.isPending} disabled={!name.trim() || !url.trim()}>
              Start watching
            </Button>
          </form>
          {add.error && <ErrorLine error={errorLine(add.error)} className="mt-3" />}
        </Card>
      )}
      {isLoading ? (
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-[300px] rounded-xl" />
          <Skeleton className="h-[300px] rounded-xl" />
        </div>
      ) : data?.length ? (
        <div className="grid grid-cols-2 gap-4">
          {data.map((s, i) => (
            <ServiceCard key={s.id} s={s} team={t} showTeam={false} i={i} />
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon="🩺" title="No services yet" line={`Give ${t.steward.name} a health URL and it will watch it.`} action={<Button variant="primary" onClick={() => setOpen(true)}>Watch a service</Button>} />
        </Card>
      )}
    </div>
  );
}
