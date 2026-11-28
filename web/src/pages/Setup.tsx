import { useEffect, useState, type ComponentProps, type ReactNode } from "react";
import { Link } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CircleCheck, Download, ArrowRight, FlaskConical } from "lucide-react";
import { api, errorLine } from "../api/client";
import { qk, useSetup } from "../api/hooks";
import type { Level, OkMessage, SetupStep, SetupStepId } from "../api/types";
import { Badge, Button, buttonClass, Card, Field, Input, PageHeader, Segmented, Select, Skeleton, Textarea } from "../components/ui";
import { KeelMark, LevelBadge } from "../components/keel";
import { useToast } from "../components/toast";
import { cn, scrollIntoStrip } from "../lib/utils";

type Values = Record<string, string>;

const DEFAULTS: Record<SetupStepId, Values> = {
  admin: { name: "", email: "", password: "", org_name: "", setup_code: "" },
  model: { provider: "anthropic", model: "claude-sonnet-4", api_key: "", base_url: "" },
  slack: { bot_token: "", app_token: "", signing_secret: "" },
  github: { mode: "token", token: "", app_id: "", private_key: "", installation_id: "" },
  policy: { default_level: "1", label_default: "internal" },
  team: { name: "", steward_name: "", emoji: "🦉", slack_channel: "", github_repo: "" },
};

const PROVIDERS = [
  { v: "anthropic", l: "Anthropic", model: "claude-sonnet-4" },
  { v: "openai", l: "OpenAI", model: "gpt-4.1" },
  { v: "azure_openai", l: "Azure OpenAI", model: "gpt-4.1" },
  { v: "ollama", l: "Ollama (local)", model: "llama3.1:70b" },
  { v: "claude_code", l: "Claude Code (local CLI)", model: "default" },
  { v: "replay", l: "Replay (offline demo)", model: "replay" },
];

const LEVELS = [
  { l: 0, n: "Observe", can: "Reads and keeps the ledger. Sends nothing." },
  { l: 1, n: "Draft", can: "Drafts replies and briefs. You approve each one." },
  { l: 2, n: "Assist", can: "Answers the front desk and posts briefs on its own." },
  { l: 3, n: "Act", can: "Files issues and nudges owners across teams." },
  { l: 4, n: "Operate", can: "Runs approved runbooks on services." },
];

const EMOJIS = ["🦉", "🦫", "🐙", "🦊", "🐢", "🐝", "🦔", "🐳", "🦜", "🐧"];

function body(step: SetupStepId, v: Values): Record<string, unknown> {
  const clean = (o: Values) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== ""));
  switch (step) {
    case "github":
      return v.mode === "token" ? { token: v.token } : clean({ app_id: v.app_id, private_key: v.private_key, installation_id: v.installation_id });
    case "policy":
      return { default_level: Number(v.default_level), label_default: v.label_default };
    case "model":
      return clean({ provider: v.provider, model: v.model, api_key: v.api_key, base_url: v.base_url });
    case "slack":
      return clean(v);
    default:
      return clean(v);
  }
}

function ResultLine({ r }: { r: OkMessage | null }) {
  return (
    <AnimatePresence mode="wait">
      {r && (
        <motion.div
          key={r.message + r.ok}
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          className={cn("flex items-start gap-2 text-[14px] rounded-lg px-3 py-2", r.ok ? "text-ok bg-ok-soft" : "text-bad bg-bad-soft")}
        >
          {r.ok ? <Check className="size-3.5 mt-[3px] shrink-0" /> : <span className="mt-[6px] size-1.5 rounded-full bg-bad shrink-0" />}
          <span>{r.message}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function StepForm({ step, v, set, manifestUrl, needsCode }: { step: SetupStepId; v: Values; set: (k: string, val: string) => void; manifestUrl: string; needsCode?: boolean }) {
  const inp = (k: string, props: Partial<ComponentProps<typeof Input>> = {}) => <Input value={v[k] ?? ""} onChange={(e) => set(k, e.target.value)} {...props} />;
  switch (step) {
    case "admin":
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Your name">{inp("name", { placeholder: "Evan Park", autoComplete: "name" })}</Field>
          <Field label="Organization">{inp("org_name", { placeholder: "Acme" })}</Field>
          <Field label="Email">{inp("email", { type: "email", placeholder: "you@company.com", autoComplete: "username" })}</Field>
          <Field label="Password" hint="At least 10 characters.">
            {inp("password", { type: "password", autoComplete: "new-password" })}
          </Field>
          {needsCode && (
            <Field
              label="Setup code"
              className="sm:col-span-2"
              hint={
                <>
                  Printed in the server log at startup. Or run <code className="font-mono text-soft">keel setup-code</code>.
                </>
              }
            >
              {inp("setup_code", { placeholder: "XXXX-XXXX", autoComplete: "one-time-code", spellCheck: false, className: "font-mono text-[14px] sm:max-w-[260px]" })}
            </Field>
          )}
        </div>
      );
    case "model": {
      const needsKey = ["anthropic", "openai", "azure_openai"].includes(v.provider);
      const needsUrl = ["ollama", "azure_openai"].includes(v.provider);
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Provider">
            <Select
              value={v.provider}
              onChange={(e) => {
                set("provider", e.target.value);
                set("model", PROVIDERS.find((p) => p.v === e.target.value)?.model ?? "");
              }}
            >
              {PROVIDERS.map((p) => (
                <option key={p.v} value={p.v}>
                  {p.l}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Model">{inp("model", { className: "font-mono text-[14px]" })}</Field>
          {needsKey && (
            <div className="sm:col-span-2">
              <Field label="API key" hint="Stored encrypted on your Keel server. Sent only to the model provider.">
                {inp("api_key", { type: "password", placeholder: v.provider === "anthropic" ? "sk-ant-…" : "sk-…", className: "font-mono text-[14px]" })}
              </Field>
            </div>
          )}
          {needsUrl && (
            <div className="sm:col-span-2">
              <Field label="Base URL">{inp("base_url", { placeholder: v.provider === "ollama" ? "http://localhost:11434" : "https://your-resource.openai.azure.com", className: "font-mono text-[14px]" })}</Field>
            </div>
          )}
          {v.provider === "replay" && <p className="sm:col-span-2 text-[12px] text-muted">Replay answers from recorded sessions. Good for trying Keel with no model at all.</p>}
        </div>
      );
    }
    case "slack":
      return (
        <div className="space-y-5">
          <ol className="space-y-2.5">
            {[
              <>
                Download the app manifest.{" "}
                <a href={manifestUrl} download="keel-slack-manifest.yaml" className="inline-flex items-center gap-1 text-accent hover:underline">
                  <Download className="size-3.5" /> keel-slack-manifest.yaml
                </a>
              </>,
              <>
                At <span className="font-mono text-[12px]">api.slack.com/apps</span>, choose <b>Create New App → From a manifest</b> and paste it.
              </>,
              <>Install it to your workspace, then copy the two tokens below.</>,
            ].map((el, i) => (
              <li key={i} className="flex items-start gap-3 text-[14px]">
                <span className="grid place-items-center size-[22px] rounded-full bg-hover text-soft text-[12px] font-semibold shrink-0">{i + 1}</span>
                <span className="pt-0.5 text-soft">{el}</span>
              </li>
            ))}
          </ol>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Bot token" hint="OAuth & Permissions. Starts with xoxb-.">
              {inp("bot_token", { placeholder: "xoxb-…", className: "font-mono text-[14px]" })}
            </Field>
            <Field label="App-level token" hint="Basic Information. Starts with xapp-.">
              {inp("app_token", { placeholder: "xapp-…", className: "font-mono text-[14px]" })}
            </Field>
            <div className="sm:col-span-2">
              <Field label="Signing secret (optional)">{inp("signing_secret", { type: "password", className: "font-mono text-[14px]" })}</Field>
            </div>
          </div>
        </div>
      );
    case "github":
      return (
        <div className="space-y-4">
          <Segmented
            value={v.mode as "token" | "app"}
            onChange={(m) => set("mode", m)}
            options={[
              { value: "token", label: "Personal token" },
              { value: "app", label: "GitHub App" },
            ]}
          />
          {v.mode === "token" ? (
            <Field label="Token" hint="Fine-grained, read access to issues, PRs and contents. Write access only if stewards should file issues.">
              {inp("token", { type: "password", placeholder: "github_pat_…", className: "font-mono text-[14px]" })}
            </Field>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="App ID">{inp("app_id", { className: "font-mono text-[14px]" })}</Field>
              <Field label="Installation ID">{inp("installation_id", { className: "font-mono text-[14px]" })}</Field>
              <div className="sm:col-span-2">
                <Field label="Private key">
                  <Textarea value={v.private_key} onChange={(e) => set("private_key", e.target.value)} rows={4} placeholder="-----BEGIN RSA PRIVATE KEY-----" className="font-mono text-[12px]" />
                </Field>
              </div>
            </div>
          )}
        </div>
      );
    case "policy":
      return (
        <div className="space-y-4">
          <div>
            <div className="text-[12px] font-medium text-soft mb-1.5">New stewards start at</div>
            <div className="grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-5 gap-2">
              {LEVELS.map((l) => (
                <button
                  key={l.l}
                  type="button"
                  onClick={() => set("default_level", String(l.l))}
                  className={cn(
                    "text-left rounded-lg border p-2.5 transition-colors cursor-pointer max-sm:flex max-sm:items-center max-sm:gap-3",
                    v.default_level === String(l.l) ? "border-fg/40 bg-hover" : "border-line hover:bg-hover",
                  )}
                >
                  <LevelBadge level={l.l as Level} name={l.n} />
                  <div className="mt-1.5 max-sm:mt-0 text-[12px] leading-snug text-muted">{l.can}</div>
                </button>
              ))}
            </div>
          </div>
          <Field label="Default label for new knowledge" hint="Stewards never show a doc to an audience its label doesn't allow.">
            <Select value={v.label_default} onChange={(e) => set("label_default", e.target.value)} className="sm:w-[220px]">
              <option value="public">Public</option>
              <option value="internal">Internal</option>
              <option value="confidential">Confidential</option>
              <option value="restricted">Restricted</option>
            </Select>
          </Field>
        </div>
      );
    case "team":
      return (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field label="Team name">{inp("name", { placeholder: "Payments" })}</Field>
          <Field label="Steward name">{inp("steward_name", { placeholder: "Pip" })}</Field>
          <div className="sm:col-span-2">
            <div className="text-[12px] font-medium text-soft mb-1.5">Steward avatar</div>
            <div className="flex flex-wrap gap-1.5">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => set("emoji", e)}
                  aria-pressed={v.emoji === e}
                  className={cn("size-9 max-sm:size-10 rounded-lg border text-[18px] grid place-items-center cursor-pointer transition-colors", v.emoji === e ? "border-fg/40 bg-hover" : "border-transparent hover:bg-hover")}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
          <Field label="Slack channel (optional)">{inp("slack_channel", { placeholder: "#payments" })}</Field>
          <Field label="GitHub repo (optional)">{inp("github_repo", { placeholder: "acme/payments-api", className: "font-mono text-[14px]" })}</Field>
        </div>
      );
  }
}

function StepPanel({ s, manifestUrl, needsCode, onNext }: { s: SetupStep; manifestUrl: string; needsCode?: boolean; onNext: () => void }) {
  const [v, setV] = useState<Values>(DEFAULTS[s.id]);
  const [result, setResult] = useState<OkMessage | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => setResult(null), [v]);
  const set = (k: string, val: string) => setV((o) => ({ ...o, [k]: val }));
  const test = useMutation({
    mutationFn: () => api.testSetup(s.id, body(s.id, v)),
    onSuccess: setResult,
    onError: (e) => setResult({ ok: false, message: errorLine(e) }),
  });
  const save = useMutation({
    mutationFn: () => api.saveSetup(s.id, body(s.id, v)),
    onSuccess: (r) => {
      if (!r.ok) return setResult(r);
      toast({ title: `${s.title} saved`, line: r.message, icon: "✅" });
      qc.invalidateQueries({ queryKey: qk.setup });
      qc.invalidateQueries({ queryKey: qk.me });
      onNext();
    },
    onError: (e) => setResult({ ok: false, message: errorLine(e) }),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-line">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[16px] font-semibold tracking-[-0.01em]">{s.title}</h2>
          {s.optional && <Badge>Optional</Badge>}
          {s.done && (
            <Badge tone="ok">
              <Check className="size-3" /> Done
            </Badge>
          )}
        </div>
        <p className="text-[14px] text-muted mt-1">{s.detail}</p>
      </div>
      <div className="px-5 py-5 sm:px-6">
        <StepForm step={s.id} v={v} set={set} manifestUrl={manifestUrl} needsCode={needsCode} />
        <div className="mt-5 min-h-[38px]">
          <ResultLine r={result} />
        </div>
      </div>
      <div className="px-5 sm:px-6 py-3 border-t border-line flex flex-wrap items-center gap-2">
        <Button type="button" variant="secondary" icon={<FlaskConical className="size-3.5" />} loading={test.isPending} onClick={() => test.mutate()}>
          Test
        </Button>
        <div className="ml-auto flex flex-wrap justify-end items-center gap-2">
          {(s.optional || s.done) && (
            <Button type="button" variant="ghost" onClick={onNext}>
              {s.done ? "Next" : "Skip for now"}
            </Button>
          )}
          <Button type="submit" variant="primary" loading={save.isPending} icon={!save.isPending ? <ArrowRight className="size-3.5" /> : undefined}>
            Save and continue
          </Button>
        </div>
      </div>
    </form>
  );
}

export function Setup({ standalone }: { standalone?: boolean }) {
  const { data, isLoading } = useSetup();
  const qc = useQueryClient();
  const [active, setActive] = useState<SetupStepId | null>(null);
  const steps = data?.steps ?? [];
  const current = steps.find((s) => s.id === active) ?? steps.find((s) => !s.done) ?? steps[0];
  const requiredLeft = steps.filter((s) => !s.done && !s.optional).length;
  const doneCount = steps.filter((s) => s.done).length;

  const next = () => {
    const i = steps.findIndex((s) => s.id === current?.id);
    const after = steps.slice(i + 1).find((s) => !s.done) ?? steps.find((s) => !s.done && s.id !== current?.id);
    setActive(after ? after.id : null);
  };

  const content: ReactNode = (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4 lg:gap-6 items-start">
      <Card className="p-2 lg:p-3 min-w-0">
        <div className="px-2.5 pt-1.5 pb-2 lg:pb-3">
          <div className="text-[12px] text-muted">
            {doneCount} of {steps.length || 6} done
          </div>
          <div className="mt-2 h-1 rounded-full bg-hover overflow-hidden">
            <motion.div className="h-full rounded-full bg-ok" initial={{ width: 0 }} animate={{ width: `${(doneCount / (steps.length || 6)) * 100}%` }} transition={{ duration: 0.6 }} />
          </div>
        </div>
        <div className="flex gap-1 scroll-x lg:block">
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11 mb-1.5 max-lg:w-28 max-lg:shrink-0 max-lg:mb-0" />)
          : steps.map((s, i) => {
              const on = s.id === current?.id;
              return (
                <button
                  key={s.id}
                  ref={on ? scrollIntoStrip : undefined}
                  onClick={() => setActive(s.id)}
                  aria-current={on ? "step" : undefined}
                  className={cn("relative shrink-0 lg:w-full flex items-center gap-2 lg:gap-3 px-2.5 py-2 lg:py-2.5 min-h-10 rounded-lg text-left cursor-pointer transition-colors", on ? "bg-hover" : "hover:bg-hover")}
                >
                  {i < steps.length - 1 && <span className="hidden lg:block absolute left-[22px] top-[38px] h-[calc(100%-26px)] w-px bg-line" />}
                  <span
                    className={cn(
                      "relative grid place-items-center size-6 rounded-full text-[12px] font-semibold border shrink-0 transition-colors",
                      s.done ? "bg-ok-soft border-transparent text-ok" : on ? "border-fg text-fg bg-panel" : "border-line-strong text-muted bg-panel",
                    )}
                  >
                    {s.done ? <Check className="size-3.5" /> : i + 1}
                  </span>
                  <span className="min-w-0">
                    <span className={cn("block whitespace-nowrap text-[14px]", on ? "font-medium text-fg" : "text-soft")}>{s.title}</span>
                    {s.optional && <span className="hidden lg:block text-[12px] text-muted">Optional</span>}
                  </span>
                </button>
              );
            })}
        </div>
      </Card>
      <Card className="min-w-0">
        {current && data ? (
          <AnimatePresence mode="wait">
            <motion.div key={current.id} initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              <StepPanel s={current} manifestUrl={data.slack_manifest_url} needsCode={current.id === "admin" && !!data.needs_setup_code} onNext={next} />
            </motion.div>
          </AnimatePresence>
        ) : (
          <Skeleton className="h-[420px] rounded-xl" />
        )}
      </Card>
    </div>
  );

  const sub = requiredLeft ? `${requiredLeft} required ${requiredLeft === 1 ? "step" : "steps"} left. Slack and GitHub can wait.` : "Keel is ready. Optional steps can be done any time.";
  const done =
    !requiredLeft &&
    data &&
    (standalone ? (
      <Button variant="primary" icon={<CircleCheck className="size-3.5" />} onClick={() => qc.invalidateQueries({ queryKey: qk.me })}>
        Open Keel
      </Button>
    ) : (
      <Link to="/" className={buttonClass("secondary")}>
        <CircleCheck className="size-3.5" />
        Back to overview
      </Link>
    ));

  if (!standalone)
    return (
      <div>
        <PageHeader title="Setup" sub={sub} right={done} />
        {content}
      </div>
    );
  return (
    <div className="bg-bg min-h-full">
      <div className="max-w-[1000px] mx-auto px-4 py-6 sm:px-8 sm:py-10">
        <div className="flex items-center gap-2.5 mb-8">
          <KeelMark size={26} />
          <span className="text-[16px] font-semibold tracking-[-0.015em]">Keel</span>
        </div>
        <div className="flex flex-col gap-3 mb-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-[-0.015em]">Set up Keel</h1>
            <p className="text-[14px] text-muted mt-1">{sub}</p>
          </div>
          {done}
        </div>
        {content}
      </div>
    </div>
  );
}
