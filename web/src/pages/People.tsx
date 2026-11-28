import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, KeyRound, UserPlus } from "lucide-react";
import { GitHubGlyph, SlackGlyph } from "../components/keel";
import { api, errorLine } from "../api/client";
import { useInvalidate, useInvites, useMe, usePeople, useTeams } from "../api/hooks";
import type { Invite, OrgRole, Person, TeamRole } from "../api/types";
import { Avatar, Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorLine, Field, Input, List, MenuItem, PageHeader, RowMenu, SectionTitle, Select, SkeletonRows, Tooltip } from "../components/ui";
import { useToast } from "../components/toast";
import { ago } from "../lib/time";
import { cn, plural } from "../lib/utils";

const PEOPLE_KEYS = ["people", "invites", "members", "team", "audit"];

export function People() {
  const { data: me } = useMe();
  const { data: people, isLoading, error } = usePeople();
  const { data: invites } = useInvites();
  const [inviting, setInviting] = useState(false);
  const [q, setQ] = useState("");
  const pending = (invites ?? []).filter((i) => i.status === "pending");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const xs = [...(people ?? [])].sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.name.localeCompare(b.name));
    return s ? xs.filter((p) => (p.name + " " + p.email + " " + p.teams.map((t) => t.name).join(" ")).toLowerCase().includes(s)) : xs;
  }, [people, q]);

  if (me?.user && me.user.role !== "org_admin") {
    return (
      <>
        <PageHeader title="People" />
        <EmptyState title="Only org admins can manage people." line="Ask an admin to invite someone or change a role." />
      </>
    );
  }

  const active = people?.filter((p) => !p.disabled).length ?? 0;
  const admins = people?.filter((p) => p.role === "org_admin" && !p.disabled).length ?? 0;

  return (
    <>
      <PageHeader
        title="People"
        sub={people ? `${plural(active, "person", "people")} · ${plural(admins, "admin")}${pending.length ? ` · ${plural(pending.length, "invite")} pending` : ""}` : "Everyone in this workspace"}
        right={
          <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setInviting(true)}>
            Invite people
          </Button>
        }
      />

      {error && <ErrorLine error={errorLine(error)} className="mb-4" />}

      <div className="flex items-center gap-3 mb-3">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find by name, email or team" className="max-w-[320px]" aria-label="Find people" />
      </div>

      {isLoading ? (
        <SkeletonRows rows={6} />
      ) : !shown.length ? (
        <List>
          <EmptyState title={q ? "No one matches that." : "No one here yet."} action={!q && <Button variant="primary" onClick={() => setInviting(true)}>Invite people</Button>} />
        </List>
      ) : (
        <List>
          {shown.map((p) => (
            <PersonRow key={p.id} p={p} self={p.id === me?.user?.id} />
          ))}
        </List>
      )}

      <SectionTitle className="mt-10">Pending invites</SectionTitle>
      {!invites ? (
        <SkeletonRows rows={2} />
      ) : !pending.length ? (
        <div className="text-[14px] text-muted py-1">No open invites.</div>
      ) : (
        <List>
          {pending.map((i) => (
            <InviteRow key={i.id} i={i} />
          ))}
        </List>
      )}

      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}

function Indicators({ p }: { p: Person }) {
  const dim = "size-3.5";
  return (
    <span className="flex items-center gap-2 text-muted">
      <Tooltip content={p.sso ? "Signs in with SSO" : "Signs in with a password"}>
        <KeyRound className={cn(dim, !p.sso && "opacity-30")} aria-label={p.sso ? "SSO" : "Password"} />
      </Tooltip>
      <Tooltip content={p.slack_linked ? "Slack linked" : "Slack not linked"}>
        <SlackGlyph className={cn(dim, !p.slack_linked && "opacity-30")} />
      </Tooltip>
      <Tooltip content={p.github_login ? `GitHub @${p.github_login}` : "GitHub not linked"}>
        <GitHubGlyph className={cn(dim, !p.github_login && "opacity-30")} />
      </Tooltip>
    </span>
  );
}

function PersonRow({ p, self }: { p: Person; self: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const patch = useMutation({
    mutationFn: (body: { role?: OrgRole; disabled?: boolean }) => api.patchPerson(p.id, body),
    onSuccess: (x, body) => {
      setRowError(null);
      toast({
        title: body.disabled !== undefined ? (body.disabled ? `${x.name} can't sign in now` : `${x.name} can sign in again`) : `${x.name} is ${x.role === "org_admin" ? "an admin" : "a member"} now`,
      });
    },
    onError: (e) => setRowError(errorLine(e)),
    onSettled: () => invalidate(...PEOPLE_KEYS),
  });
  const remove = useMutation({
    mutationFn: () => api.removePerson(p.id),
    onSuccess: (r) => {
      setConfirm(false);
      toast({ title: r.message });
    },
    onSettled: () => invalidate(...PEOPLE_KEYS),
  });

  return (
    <div className={cn("group flex items-center gap-3 px-4 py-3 hover:bg-panel-2 transition-colors", p.disabled && "opacity-60")}>
      <Avatar name={p.name} url={p.avatar_url} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[14px] font-medium truncate">{p.name}</span>
          {self && <span className="text-[12px] text-muted">you</span>}
          {p.role === "org_admin" && <Badge>Admin</Badge>}
          {p.disabled && <Badge tone="warn">Disabled</Badge>}
        </div>
        <div className="text-[12px] text-muted truncate mt-0.5">
          {p.email}
          <span className="max-sm:hidden">
            {" · "}
            {p.last_seen_at ? `seen ${ago(p.last_seen_at)}` : "never signed in"}
          </span>
        </div>
        {rowError && <div className="text-[12px] text-bad mt-1">{rowError}</div>}
      </div>
      <div className="max-md:hidden w-[220px] shrink-0 text-[13px] text-soft truncate">
        {p.teams.length ? (
          p.teams.map((t, i) => (
            <span key={t.slug}>
              {i > 0 && ", "}
              <Link to={`/teams/${t.slug}/settings`} className="hover:text-fg">
                {t.name}
              </Link>
              {t.role === "admin" && <span className="text-muted"> (admin)</span>}
            </span>
          ))
        ) : (
          <span className="text-muted">No teams</span>
        )}
      </div>
      <div className="max-sm:hidden shrink-0">
        <Indicators p={p} />
      </div>
      <RowMenu open={menu} setOpen={setMenu} label={`Actions for ${p.name}`}>
        <MenuItem disabled={self} onClick={() => patch.mutate({ role: p.role === "org_admin" ? "member" : "org_admin" })}>
          {p.role === "org_admin" ? "Make member" : "Make admin"}
        </MenuItem>
        <MenuItem disabled={self} onClick={() => patch.mutate({ disabled: !p.disabled })}>
          {p.disabled ? "Enable" : "Disable"}
        </MenuItem>
        <MenuItem disabled={self} danger onClick={() => setConfirm(true)}>
          Remove…
        </MenuItem>
      </RowMenu>
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => remove.mutate()}
        busy={remove.isPending}
        error={remove.error ? errorLine(remove.error) : null}
        title={`Remove ${p.name}?`}
        line={`They lose access to Acme and leave ${p.teams.length ? plural(p.teams.length, "team") : "no teams"}. Their past work stays in the ledger and audit log.`}
        confirmLabel="Remove"
      />
    </div>
  );
}

function InviteRow({ i }: { i: Invite }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const revoke = useMutation({
    mutationFn: () => api.revokeInvite(i.id),
    onSuccess: (r) => toast({ title: "Invite revoked", line: r.message }),
    onError: (e) => toast({ tone: "bad", title: "Couldn't revoke the invite", line: errorLine(e) }),
    onSettled: () => invalidate("invites"),
  });
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <Avatar name={i.email} size={32} className="bg-transparent border border-dashed border-line-strong text-muted" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium truncate">{i.email}</span>
          {i.role === "org_admin" && <Badge>Admin</Badge>}
        </div>
        <div className="text-[12px] text-muted truncate mt-0.5">
          Invited by {i.invited_by} {ago(i.created_at)} · expires {ago(i.expires_at)}
          {i.teams.length > 0 && ` · ${i.teams.map((t) => t.name + (t.role === "admin" ? " (admin)" : "")).join(", ")}`}
        </div>
      </div>
      <Button size="sm" variant="ghost" loading={revoke.isPending} onClick={() => revoke.mutate()}>
        Revoke
      </Button>
    </div>
  );
}

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: teams } = useTeams();
  const invalidate = useInvalidate();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("member");
  const [picked, setPicked] = useState<Record<string, TeamRole | undefined>>({});
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api.createInvite({
        email: email.trim(),
        role,
        teams: Object.entries(picked)
          .filter(([, r]) => r)
          .map(([slug, r]) => ({ slug, role: r! })),
      }),
    onSuccess: (r) => {
      setLink(new URL(r.url, location.origin).toString());
      invalidate("invites");
    },
  });

  const reset = () => {
    setEmail("");
    setRole("member");
    setPicked({});
    setLink(null);
    setCopied(false);
    create.reset();
  };
  const close = () => {
    onClose();
    setTimeout(reset, 200);
  };
  const copy = async () => {
    if (!link) return;
    await navigator.clipboard?.writeText(link).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  if (link)
    return (
      <Dialog
        open={open}
        onClose={close}
        title="Invite ready"
        sub={`For ${email.trim()}`}
        footer={
          <>
            <Button variant="ghost" onClick={reset}>
              Invite someone else
            </Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-2">
          <Input readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[13px]" aria-label="Invite link" />
          <Button variant="secondary" onClick={copy} icon={copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />} data-autofocus>
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-[14px] text-muted mt-3">Send this link to them. It works once and expires in 7 days.</p>
      </Dialog>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Invite people"
      sub="They get a one-time link to join Acme."
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="invite-form" loading={create.isPending} disabled={!email.trim()}>
            Create invite
          </Button>
        </>
      }
    >
      <form
        id="invite-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@acme.dev" required autoFocus />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
              <option value="member">Member</option>
              <option value="org_admin">Admin</option>
            </Select>
          </Field>
        </div>
        <div>
          <div className="text-[12px] font-medium text-soft mb-1.5">Teams</div>
          <div className="rounded-lg border border-line divide-y divide-line">
            {(teams ?? []).map((t) => {
              const r = picked[t.slug];
              return (
                <div key={t.slug} className="flex items-center gap-3 px-3 h-11">
                  <label className="flex items-center gap-2.5 flex-1 min-w-0 cursor-pointer">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--accent)] cursor-pointer"
                      checked={!!r}
                      onChange={(e) => setPicked((x) => ({ ...x, [t.slug]: e.target.checked ? "member" : undefined }))}
                    />
                    <span className="size-2 rounded-full shrink-0" style={{ background: t.color }} />
                    <span className="text-[14px] truncate">{t.name}</span>
                    <span className="text-[14px]" aria-hidden>
                      {t.steward.emoji}
                    </span>
                  </label>
                  <Select
                    aria-label={`Role in ${t.name}`}
                    value={r ?? "member"}
                    disabled={!r}
                    onChange={(e) => setPicked((x) => ({ ...x, [t.slug]: e.target.value as TeamRole }))}
                    className="w-[120px] h-8 text-[13px]"
                  >
                    <option value="member">Member</option>
                    <option value="admin">Team admin</option>
                  </Select>
                </div>
              );
            })}
          </div>
          <div className="text-[12px] text-muted mt-1.5">You can change teams later.</div>
        </div>
        {create.error && <ErrorLine error={errorLine(create.error)} />}
      </form>
    </Dialog>
  );
}
