import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Search } from "lucide-react";
import { api, errorLine } from "../../api/client";
import { qk, useKnowledge } from "../../api/hooks";
import type { Label, TeamDetail } from "../../api/types";
import { Button, Card, EmptyState, ErrorLine, Field, Input, Segmented, Select, SkeletonRows, Textarea } from "../../components/ui";
import { LabelBadge } from "../../components/keel";
import { useToast } from "../../components/toast";
import { ago } from "../../lib/time";

type LF = "all" | Label;

export function KnowledgeTab({ t }: { t: TeamDetail }) {
  const { data, isLoading } = useKnowledge(t.slug);
  const [lf, setLf] = useState<LF>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", content: "", label: "internal" as Label, source: "" });
  const qc = useQueryClient();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () => api.addKnowledge(t.slug, { title: form.title.trim(), content: form.content, label: form.label, source: form.source.trim() || undefined }),
    onSuccess: (d) => {
      setForm({ title: "", content: "", label: "internal", source: "" });
      setOpen(false);
      qc.invalidateQueries({ queryKey: qk.knowledge(t.slug) });
      toast({ title: `${t.steward.name} learned "${d.title}"`, line: `Labeled ${d.label}.`, icon: "📚" });
    },
  });
  const counts = useMemo(() => {
    const m: Record<string, number> = { all: data?.length ?? 0 };
    for (const d of data ?? []) m[d.label] = (m[d.label] ?? 0) + 1;
    return m;
  }, [data]);
  const docs = (data ?? []).filter((d) => (lf === "all" || d.label === lf) && (!q || (d.title + d.snippet + d.source).toLowerCase().includes(q.toLowerCase())));

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Segmented
          size="sm"
          value={lf}
          onChange={setLf}
          options={(["all", "public", "internal", "confidential", "restricted"] as LF[]).map((v) => ({ value: v, label: v === "all" ? "All" : v[0].toUpperCase() + v.slice(1), count: counts[v] ?? 0 }))}
        />
        <div className="relative ml-auto w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter docs…" className="pl-8 h-8 text-[13px]" />
        </div>
        <Button icon={<Plus className="size-3.5" />} onClick={() => setOpen((o) => !o)}>
          Add a doc
        </Button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <Card className="p-5 mb-4">
              <form
                className="grid grid-cols-[minmax(0,1fr)_180px] gap-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  add.mutate();
                }}
              >
                <Field label="Title">
                  <Input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="How we handle chargebacks" />
                </Field>
                <Field label="Label">
                  <Select value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value as Label })}>
                    <option value="public">Public</option>
                    <option value="internal">Internal</option>
                    <option value="confidential">Confidential</option>
                    <option value="restricted">Restricted</option>
                  </Select>
                </Field>
                <div className="col-span-2">
                  <Field label="Content" hint="Markdown is fine. The steward quotes only what the asker's label allows.">
                    <Textarea rows={5} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
                  </Field>
                </div>
                <Field label="Source (optional)">
                  <Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="Notion · Payments/FAQ" />
                </Field>
                <div className="flex items-end justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" variant="primary" loading={add.isPending} disabled={!form.title.trim() || !form.content.trim()}>
                    Add
                  </Button>
                </div>
                {add.error && <ErrorLine error={errorLine(add.error)} className="col-span-2" />}
              </form>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {isLoading ? (
        <SkeletonRows rows={6} className="[&>*]:h-16" />
      ) : !docs.length ? (
        <Card>
          <EmptyState icon="📚" title={data?.length ? "No docs match" : "No knowledge yet"} line={data?.length ? "Try another label or word." : `Add a doc and ${t.steward.name} can answer questions from it.`} />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {docs.map((d, i) => (
            <motion.div key={d.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.02 }} className="flex items-start gap-3.5 px-5 py-3.5 border-b border-line last:border-b-0 hover:bg-hover/50 transition-colors">
              <span className="mt-0.5 grid place-items-center size-8 rounded-lg bg-sunken border border-line shrink-0">
                <FileText className="size-4 text-faint" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-medium truncate">{d.title}</span>
                  <LabelBadge label={d.label} />
                </div>
                <div className="text-[12.5px] text-muted mt-0.5 line-clamp-1">{d.snippet}</div>
                <div className="text-[11.5px] text-faint mt-1">
                  {d.source} · {(d.chars / 1000).toFixed(1)}k chars · updated {ago(d.updated_at)}
                </div>
              </div>
            </motion.div>
          ))}
        </Card>
      )}
    </div>
  );
}
