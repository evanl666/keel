import { useMemo, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, FileText, FileUp, Globe, Plus, RefreshCw, Search } from "lucide-react";
import { api, errorLine } from "../../api/client";
import { useInvalidate, useKnowledge, useKnowledgeDoc, useKnowledgeSources } from "../../api/hooks";
import type { KnowledgeDoc, KnowledgeOrigin, KnowledgeSource, Label, TeamDetail } from "../../api/types";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorLine, Field, Input, List, Segmented, SectionTitle, Select, Sheet, Skeleton, SkeletonRows, Textarea, Tooltip } from "../../components/ui";
import { GitHubGlyph, LabelBadge, Markdown, SlackGlyph } from "../../components/keel";
import { useToast } from "../../components/toast";
import { ago, fullDate } from "../../lib/time";
import { cn } from "../../lib/utils";

type LF = "all" | Label;
const LABELS: Label[] = ["public", "internal", "confidential", "restricted"];
const KNOWLEDGE_KEYS = ["knowledge", "knowledge-doc", "knowledge-sources", "team", "audit"];

const ORIGIN: Record<KnowledgeOrigin, { label: string; icon: ReactNode }> = {
  manual: { label: "Written here", icon: <FileText className="size-4" /> },
  file: { label: "Uploaded file", icon: <FileUp className="size-4" /> },
  url: { label: "Web page", icon: <Globe className="size-4" /> },
  github: { label: "GitHub", icon: <GitHubGlyph className="size-4" /> },
  slack: { label: "Slack", icon: <SlackGlyph className="size-4" /> },
};

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** "2025-06-03" → "Jun 3" (or "Jun 3, 2026" outside this year). */
function day(ymd: string) {
  const d = new Date(ymd + "T12:00:00");
  if (isNaN(+d)) return ymd;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function OriginIcon({ origin }: { origin: KnowledgeOrigin }) {
  const o = ORIGIN[origin] ?? ORIGIN.manual;
  return (
    <Tooltip content={o.label}>
      <span className="mt-0.5 grid place-items-center size-8 rounded-lg bg-hover text-muted shrink-0" aria-label={o.label}>
        {o.icon}
      </span>
    </Tooltip>
  );
}

export function KnowledgeTab({ t }: { t: TeamDetail }) {
  const { data, isLoading } = useKnowledge(t.slug);
  const { data: sources } = useKnowledgeSources(t.slug);
  const [lf, setLf] = useState<LF>("all");
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: data?.length ?? 0 };
    for (const d of data ?? []) m[d.label] = (m[d.label] ?? 0) + 1;
    return m;
  }, [data]);
  const stale = (data ?? []).filter((d) => d.stale).length;
  const docs = (data ?? [])
    .filter((d) => (lf === "all" || d.label === lf) && (!q || (d.title + d.snippet + d.source).toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => Number(b.stale) - Number(a.stale));
  const open = data?.find((d) => d.id === openId) ?? null;

  return (
    <div className="space-y-8">
      <section>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-3">
          <Segmented
            value={lf}
            onChange={setLf}
            options={(["all", ...LABELS] as LF[]).map((v) => ({ value: v, label: v === "all" ? "All" : cap(v), count: counts[v] ?? 0 }))}
          />
          <div className="relative min-w-0 flex-1 sm:flex-none sm:w-[220px] sm:ml-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter docs…" className="pl-8" aria-label="Filter docs" />
          </div>
          <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
            Add a doc
          </Button>
        </div>
        {stale > 0 && (
          <div className="mb-3 text-[12px] text-warn">
            {stale} {stale === 1 ? "doc is" : "docs are"} past the review date. Open one and mark it "Still true", or edit it.
          </div>
        )}
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : !docs.length ? (
          <EmptyState
            title={data?.length ? "No docs match" : "No knowledge yet"}
            line={data?.length ? "Try another label or word." : `Add a doc or a source and ${t.steward.name} can answer questions from it.`}
            action={!data?.length && <Button onClick={() => setAdding(true)}>Add a doc</Button>}
          />
        ) : (
          <List>
            {docs.map((d) => (
              <DocRow key={d.id} d={d} onOpen={() => setOpenId(d.id)} />
            ))}
          </List>
        )}
      </section>

      <Sources t={t} sources={sources} />

      <AddDoc t={t} open={adding} onClose={() => setAdding(false)} />
      <DocSheet t={t} doc={open} sources={sources ?? []} onClose={() => setOpenId(null)} />
    </div>
  );
}

function DocRow({ d, onOpen }: { d: KnowledgeDoc; onOpen: () => void }) {
  return (
    <div className="group relative flex items-start gap-3 px-4 py-3 hover:bg-hover/60 transition-colors">
      <OriginIcon origin={d.origin} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <button type="button" onClick={onOpen} className="text-[14px] font-medium truncate text-left cursor-pointer after:absolute after:inset-0 focus-visible:outline-none focus-visible:underline">
            {d.title}
          </button>
          <LabelBadge label={d.label} className="shrink-0" />
          {d.stale && (
            <Badge tone="warn" className="shrink-0">
              Stale
            </Badge>
          )}
        </div>
        <div className="text-[12px] text-muted mt-0.5 line-clamp-2 sm:line-clamp-1">{d.snippet}</div>
        <div className="text-[12px] text-muted mt-1 flex flex-wrap items-center gap-x-1.5">
          {d.source_url ? (
            <a href={d.source_url} target="_blank" rel="noreferrer" className="relative z-10 inline-flex items-center gap-1 text-soft hover:text-accent hover:underline">
              {d.source}
              <ExternalLink className="size-3" />
            </a>
          ) : (
            <span>{sourceLabel(d)}</span>
          )}
          <span>·</span>
          <span>updated {ago(d.updated_at)}</span>
          {d.review_by && (
            <>
              <span>·</span>
              <span className={cn(d.stale && "text-warn")}>Review by {day(d.review_by)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LabelSelect({ value, onChange }: { value: Label; onChange: (l: Label) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value as Label)}>
      {LABELS.map((l) => (
        <option key={l} value={l}>
          {cap(l)}
        </option>
      ))}
    </Select>
  );
}

const BLANK = { title: "", content: "", label: "internal" as Label, source: "", review_by: "" };

function AddDoc({ t, open, onClose }: { t: TeamDetail; open: boolean; onClose: () => void }) {
  const [form, setForm] = useState(BLANK);
  const invalidate = useInvalidate();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () =>
      api.addKnowledge(t.slug, { title: form.title.trim(), content: form.content, label: form.label, source: form.source.trim() || undefined, review_by: form.review_by || undefined }),
    onSuccess: (d) => {
      setForm(BLANK);
      onClose();
      invalidate(...KNOWLEDGE_KEYS);
      toast({ title: `${t.steward.name} learned "${d.title}"`, line: `Labeled ${d.label}.`, icon: "📚" });
    },
  });
  const close = () => {
    add.reset();
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a doc"
      sub={`${t.steward.name} answers from it, quoting only what the asker's label allows.`}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="add-doc" variant="primary" loading={add.isPending} disabled={!form.title.trim() || !form.content.trim()}>
            Add doc
          </Button>
        </>
      }
    >
      <form
        id="add-doc"
        className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_160px] gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.title.trim() && form.content.trim()) add.mutate();
        }}
      >
        <Field label="Title">
          <Input data-autofocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="How we handle chargebacks" />
        </Field>
        <Field label="Label">
          <LabelSelect value={form.label} onChange={(label) => setForm({ ...form, label })} />
        </Field>
        <Field label="Content" hint="Markdown is fine." className="sm:col-span-2">
          <Textarea rows={7} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        </Field>
        <Field label="Source (optional)">
          <Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="Notion · Payments/FAQ" />
        </Field>
        <Field label="Review by (optional)">
          <Input type="date" value={form.review_by} onChange={(e) => setForm({ ...form, review_by: e.target.value })} />
        </Field>
        {add.error && <ErrorLine error={errorLine(add.error)} className="sm:col-span-2" />}
      </form>
    </Dialog>
  );
}

/** Where a doc came from, in words: Keel's own ``keel://`` ids mean it was written here. */
function sourceLabel(d: KnowledgeDoc): string {
  if (!d.source || d.source.startsWith("keel://")) return d.origin === "slack" ? "Saved from Slack" : "Written in Keel";
  return d.source;
}

function DocSheet({ t, doc, sources, onClose }: { t: TeamDetail; doc: KnowledgeDoc | null; sources: KnowledgeSource[]; onClose: () => void }) {
  const [last, setLast] = useState<KnowledgeDoc | null>(doc);
  if (doc && doc !== last) setLast(doc);
  const d = doc ?? last;
  return (
    <Sheet
      open={!!doc}
      onClose={onClose}
      title={d?.title ?? ""}
      sub={d ? `${sourceLabel(d)} · updated ${ago(d.updated_at)}` : undefined}
      width={600}
    >
      {d && <DocBody key={d.id} t={t} d={d} sources={sources} onClose={onClose} />}
    </Sheet>
  );
}

function DocBody({ t, d, sources, onClose }: { t: TeamDetail; d: KnowledgeDoc; sources: KnowledgeSource[]; onClose: () => void }) {
  const { data: full, error } = useKnowledgeDoc(t.slug, d.id);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [form, setForm] = useState({ title: d.title, content: "", label: d.label, review_by: d.review_by ?? "" });
  const invalidate = useInvalidate();
  const toast = useToast();
  const synced = d.sync_id ? (sources.find((s) => s.id === d.sync_id)?.target ?? d.source) : null;
  const save = useMutation({
    mutationFn: () => api.patchKnowledge(t.slug, d.id, { title: form.title.trim(), content: form.content, label: form.label, review_by: form.review_by || null }),
    onSuccess: () => {
      setEditing(false);
      invalidate(...KNOWLEDGE_KEYS);
      toast({ title: "Doc saved", line: form.title.trim(), icon: "📚" });
    },
  });
  const reviewed = useMutation({
    mutationFn: () => api.reviewedKnowledge(t.slug, d.id),
    onSuccess: (x) => {
      invalidate(...KNOWLEDGE_KEYS);
      toast({ title: "Marked as still true", line: x.review_by ? `Next review by ${day(x.review_by)}.` : undefined, icon: "✅" });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteKnowledge(t.slug, d.id),
    onSuccess: () => {
      setConfirm(false);
      onClose();
      invalidate(...KNOWLEDGE_KEYS);
      toast({ title: `"${d.title}" deleted`, line: `${t.steward.name} won't answer from it anymore.`, icon: "🗑️" });
    },
  });
  const startEdit = () => {
    setForm({ title: d.title, content: full?.content ?? "", label: d.label, review_by: d.review_by ?? "" });
    save.reset();
    setEditing(true);
  };
  const actionError = reviewed.error ?? save.error;

  return (
    <div className="flex flex-col min-h-full">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
        <LabelBadge label={d.label} />
        {d.stale && <Badge tone="warn">Stale</Badge>}
        {d.review_by && <span className={cn(d.stale && "text-warn")}>Review by {day(d.review_by)}</span>}
        <span>{(d.chars / 1000).toFixed(1)}k chars</span>
        {d.source_url && (
          <a href={d.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
            Open source <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {synced && (
        <div className="mt-4 flex items-center gap-2 rounded-lg bg-hover px-3 py-2 text-[14px] text-soft">
          <RefreshCw className="size-3.5 text-muted shrink-0" />
          <span className="min-w-0">
            Synced from <span className="font-mono text-[13px] text-fg break-all">{synced}</span>. Edit it there.
          </span>
        </div>
      )}

      {editing ? (
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <Field label="Title">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} data-autofocus />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label">
              <LabelSelect value={form.label} onChange={(label) => setForm({ ...form, label })} />
            </Field>
            <Field label="Review by">
              <Input type="date" value={form.review_by} onChange={(e) => setForm({ ...form, review_by: e.target.value })} />
            </Field>
          </div>
          <Field label="Content" hint="Markdown is fine.">
            <Textarea rows={14} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} className="font-mono text-[13px] leading-relaxed" />
          </Field>
          {save.error && <ErrorLine error={errorLine(save.error)} />}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={save.isPending} disabled={!form.title.trim() || !form.content.trim()}>
              Save
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="mt-5 flex-1">
            {error ? (
              <ErrorLine error={errorLine(error)} />
            ) : full ? (
              <Markdown>{full.content}</Markdown>
            ) : (
              <div className="space-y-2.5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-5/6" />
              </div>
            )}
          </div>
          {actionError && <ErrorLine error={errorLine(actionError)} className="mt-4" />}
          <div className="sticky bottom-0 -mx-5 sm:-mx-6 -mb-5 mt-6 px-5 sm:px-6 py-3 border-t border-line bg-panel flex flex-wrap items-center gap-2">
            {!synced && (
              <Button variant="primary" onClick={startEdit} disabled={!full}>
                Edit
              </Button>
            )}
            <Button variant="secondary" loading={reviewed.isPending} onClick={() => reviewed.mutate()} title="Confirm it's still accurate and push the review date out">
              Still true
            </Button>
            <Button
              variant="ghost"
              className="ml-auto hover:text-bad"
              onClick={() => {
                remove.reset();
                setConfirm(true);
              }}
            >
              Delete
            </Button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => remove.mutate()}
        busy={remove.isPending}
        error={remove.error ? errorLine(remove.error) : null}
        title={`Delete "${d.title}"?`}
        line={synced ? `It comes back on the next sync unless you remove it from ${synced}.` : `${t.steward.name} stops answering from it. This can't be undone.`}
        confirmLabel="Delete doc"
      />
    </div>
  );
}

function Sources({ t, sources }: { t: TeamDetail; sources: KnowledgeSource[] | undefined }) {
  const [adding, setAdding] = useState(false);
  return (
    <section>
      <SectionTitle
        right={
          <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
            Add source
          </Button>
        }
      >
        Sources
      </SectionTitle>
      <div className="text-[12px] text-muted -mt-1 mb-3">Web pages and GitHub folders {t.steward.name} keeps in sync. Synced docs are read-only here.</div>
      {!sources ? (
        <SkeletonRows rows={2} />
      ) : sources.length ? (
        <List>
          {sources.map((s) => (
            <SourceRow key={s.id} t={t} s={s} />
          ))}
        </List>
      ) : (
        <EmptyState title="No sources yet" line="Add a URL or a GitHub folder and the docs stay up to date by themselves." action={<Button onClick={() => setAdding(true)}>Add source</Button>} />
      )}
      <AddSource t={t} open={adding} onClose={() => setAdding(false)} />
    </section>
  );
}

function SourceRow({ t, s }: { t: TeamDetail; s: KnowledgeSource }) {
  const [confirm, setConfirm] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();
  const sync = useMutation({
    mutationFn: () => api.syncKnowledgeSource(t.slug, s.id),
    onSuccess: () => invalidate("knowledge-sources"),
  });
  const remove = useMutation({
    mutationFn: () => api.removeKnowledgeSource(t.slug, s.id),
    onSuccess: () => {
      setConfirm(false);
      invalidate(...KNOWLEDGE_KEYS);
      toast({ title: "Source removed", line: s.target, icon: "🗑️" });
    },
  });
  const pending = s.status === "pending" || sync.isPending;
  const href = s.kind === "url" ? s.target : `https://github.com/${s.target.split("/").slice(0, 2).join("/")}${s.target.split("/").length > 2 ? "/tree/HEAD/" + s.target.split("/").slice(2).join("/") : ""}`;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 grid place-items-center size-8 rounded-lg bg-hover text-muted shrink-0">{s.kind === "github" ? <GitHubGlyph className="size-4" /> : <Globe className="size-4" />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <a href={href} target="_blank" rel="noreferrer" className="text-[14px] font-medium truncate hover:underline font-mono">
            {s.target}
          </a>
          <LabelBadge label={s.label} className="shrink-0" />
        </div>
        <div className={cn("text-[12px] mt-0.5 flex items-start gap-1.5", s.status === "error" && !pending ? "text-bad" : "text-muted")}>
          <span className={cn("mt-[5px] size-1.5 rounded-full shrink-0", pending ? "bg-accent live-dot" : s.status === "ok" ? "bg-ok" : "bg-bad")} />
          <span className="min-w-0">{pending ? "Syncing…" : s.status_line}</span>
        </div>
        <div className="text-[12px] text-muted mt-0.5">
          {s.last_synced_at ? <span title={fullDate(s.last_synced_at)}>Synced {ago(s.last_synced_at)}</span> : "Not synced yet"} · {s.docs} {s.docs === 1 ? "doc" : "docs"}
        </div>
        {sync.error && <div className="text-[12px] text-bad mt-0.5">{errorLine(sync.error)}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="secondary" icon={<RefreshCw className={cn("size-3.5", pending && "animate-spin")} />} disabled={pending} onClick={() => sync.mutate()}>
          <span className="max-sm:hidden">Sync now</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            remove.reset();
            setConfirm(true);
          }}
        >
          Remove
        </Button>
      </div>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => remove.mutate()}
        busy={remove.isPending}
        error={remove.error ? errorLine(remove.error) : null}
        title="Remove this source?"
        line={`Its ${s.docs} synced ${s.docs === 1 ? "doc goes" : "docs go"} too. ${t.steward.name} stops answering from ${s.docs === 1 ? "it" : "them"}.`}
        confirmLabel="Remove source"
      />
    </div>
  );
}

function AddSource({ t, open, onClose }: { t: TeamDetail; open: boolean; onClose: () => void }) {
  const [kind, setKind] = useState<KnowledgeSource["kind"]>("url");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState<Label>("internal");
  const invalidate = useInvalidate();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () => api.addKnowledgeSource(t.slug, { kind, target: target.trim(), label }),
    onSuccess: (s) => {
      setTarget("");
      onClose();
      invalidate(...KNOWLEDGE_KEYS);
      toast({ title: `${t.steward.name} is syncing it`, line: s.target, icon: "🔄" });
    },
  });
  const close = () => {
    add.reset();
    onClose();
  };
  const ok = kind === "url" ? /^https?:\/\/\S+\.\S+/.test(target.trim()) : /^[\w.-]+\/[\w.-]+(\/\S*)?$/.test(target.trim());
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Add a source"
      sub="Keel fetches it now and again every day."
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form="add-source" variant="primary" loading={add.isPending} disabled={!ok}>
            Add source
          </Button>
        </>
      }
    >
      <form
        id="add-source"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) add.mutate();
        }}
      >
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "url", label: "Web page" },
            { value: "github", label: "GitHub folder" },
          ]}
        />
        <Field label={kind === "url" ? "URL" : "Repository and folder"} hint={kind === "url" ? "A public page, or one Keel can reach." : "Like acme/payments-api/docs. Markdown files in it become docs."}>
          <Input
            data-autofocus
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={kind === "url" ? "https://wiki.acme.dev/payments/faq" : "acme/payments-api/docs"}
            className="font-mono text-[13px]"
          />
        </Field>
        <Field label="Label for its docs">
          <LabelSelect value={label} onChange={setLabel} />
        </Field>
        {add.error && <ErrorLine error={errorLine(add.error)} />}
      </form>
    </Dialog>
  );
}
