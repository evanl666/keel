import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, errorLine } from "../../api/client";
import { useInvalidate, useMe, useMembers, usePatchSteward } from "../../api/hooks";
import type { Duty, Member, TeamDetail, TeamRole } from "../../api/types";
import { Avatar, Badge, Button, Card, CardHeader, ConfirmDialog, Dialog, ErrorLine, Field, Input, MenuItem, RowMenu, Select, SkeletonRows, Switch, Textarea } from "../../components/ui";
import { DUTY_META, StewardAvatar } from "../../components/keel";
import { useToast } from "../../components/toast";
import { cn } from "../../lib/utils";

const ALL_DUTIES: { id: Duty; line: string }[] = [
  { id: "ledger", line: "Tracks promises from Slack and GitHub." },
  { id: "front_desk", line: "Answers other teams from team knowledge." },
  { id: "rhythm", line: "Writes the daily and weekly briefs." },
  { id: "services", line: "Checks health URLs and opens incidents." },
  { id: "knowledge", line: "Keeps docs indexed and labeled." },
  { id: "chores", line: "Nudges owners and tidies stale items." },
];

const EMOJIS = ["🦉", "🦫", "🐙", "🦊", "🐢", "🐝", "🦔", "🐳", "🦜", "🐧", "🦄", "🐼"];

export function SettingsTab({ t }: { t: TeamDetail }) {
  const patch = usePatchSteward(t.slug);
  const toast = useToast();
  const [name, setName] = useState(t.steward.name);
  const [emoji, setEmoji] = useState(t.steward.emoji);
  const [duties, setDuties] = useState<Duty[]>(t.steward.duties);
  const dirty = name !== t.steward.name || emoji !== t.steward.emoji || duties.join() !== t.steward.duties.join();
  const save = () =>
    patch.mutate(
      { name: name.trim(), emoji, duties },
      {
        onSuccess: (s) => toast({ title: "Saved", line: `${s.emoji} ${s.name} has ${duties.length} ${duties.length === 1 ? "duty" : "duties"}.`, icon: "✅" }),
        onError: (e) => toast({ title: "Not saved", line: errorLine(e), tone: "bad" }),
      },
    );

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="Steward" sub="How the steward shows up in Slack and here." />
        <div className="px-5 pb-5 space-y-4">
          <div className="flex items-center gap-4">
            <StewardAvatar emoji={emoji} color={t.color} size="lg" paused={t.steward.paused} />
            <div className="flex-1 min-w-0 max-w-[320px]">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
              </Field>
            </div>
          </div>
          <div>
            <div className="text-[12px] font-medium text-soft mb-1.5">Avatar</div>
            <div className="flex flex-wrap gap-1.5">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => setEmoji(e)}
                  aria-pressed={emoji === e}
                  className={cn("size-9 max-sm:size-10 rounded-lg border text-[18px] grid place-items-center cursor-pointer transition-colors", emoji === e ? "border-fg/40 bg-hover" : "border-transparent hover:bg-hover")}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="px-5 pt-4 border-t border-line">
          <div className="text-[14px] font-semibold">Duties</div>
          <div className="text-[12px] text-muted">Turn off what this team doesn't need. The steward stops that work right away.</div>
        </div>
        <div className="px-5 pb-2">
          {ALL_DUTIES.map((d) => {
            const on = duties.includes(d.id);
            return (
              <div key={d.id} className="flex items-center gap-3 py-3 border-t border-line first:border-t-0">
                <span className="text-[18px] w-7 shrink-0 text-center">{DUTY_META[d.id].icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[14px] font-medium">{DUTY_META[d.id].label}</div>
                  <div className="text-[12px] text-muted">{on ? d.line : "Off. The steward skips this."}</div>
                </div>
                <Switch checked={on} label={DUTY_META[d.id].label} onChange={(v) => setDuties((ds) => (v ? ALL_DUTIES.map((x) => x.id).filter((x) => x === d.id || ds.includes(x)) : ds.filter((x) => x !== d.id)))} />
              </div>
            );
          })}
        </div>
        <div className="px-5 py-3.5 border-t border-line flex items-center justify-end gap-2">
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setName(t.steward.name);
                setEmoji(t.steward.emoji);
                setDuties(t.steward.duties);
              }}
            >
              Discard
            </Button>
          )}
          <Button variant="primary" disabled={!dirty || !name.trim()} loading={patch.isPending} onClick={save}>
            Save changes
          </Button>
        </div>
      </Card>
    <TeamForm t={t} />
    <Members t={t} />
    <DangerZone t={t} />
    </div>
  );
}

const TEAM_KEYS = ["team", "teams", "overview", "members", "people", "audit"];
const lines = (v: string) => v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

function slackLine(st: TeamDetail["settings"]) {
  if (!st.slack_channel) return "No channel yet. The steward posts briefs and answers there.";
  if (st.slack_channel_id) return `Linked to ${st.slack_channel.startsWith("#") ? st.slack_channel : "#" + st.slack_channel}`;
  if (!st.slack_connected) return "Slack isn't connected yet. Connect it in Setup.";
  return "Not found yet; Keel looks it up when Slack is connected.";
}

function TeamForm({ t }: { t: TeamDetail }) {
  const st = t.settings;
  const toast = useToast();
  const invalidate = useInvalidate();
  const init = () => ({
    name: t.name,
    slack: st.slack_channel ?? "",
    repos: st.github_repos.join("\n"),
    tz: st.timezone,
    hour: String(st.brief_hour),
    sso: st.sso_groups.join(", "),
  });
  const [f, setF] = useState(init);
  const set = (k: keyof ReturnType<typeof init>) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const { data: me } = useMe();
  const canEdit = t.my_role === "admin" || me?.user?.role === "org_admin";
  const save = useMutation({
    mutationFn: () =>
      api.patchTeam(t.slug, {
        name: f.name.trim(),
        slack_channel: f.slack.trim(),
        github_repos: lines(f.repos),
        timezone: f.tz.trim() || "UTC",
        brief_hour: Number(f.hour),
        sso_groups: lines(f.sso),
      }),
    onSuccess: () => {
      invalidate(...TEAM_KEYS);
      toast({ title: "Team saved", icon: "✅" });
    },
  });
  const tzs = (() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  })();
  const linked = !!st.slack_channel_id;
  return (
    <Card>
      <CardHeader title="Team" sub={canEdit ? "Where the steward works and when it writes the brief." : "Only team admins can change these."} />
      <form
        className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <fieldset disabled={!canEdit} className="contents">
          <Field label="Name">
            <Input value={f.name} onChange={set("name")} maxLength={40} />
          </Field>
          <Field
            label="Slack channel"
            hint={
              <span className={cn("inline-flex items-center gap-1.5", st.slack_channel && !linked && "text-warn")}>
                <span className={cn("size-1.5 rounded-full", linked ? "bg-ok" : st.slack_channel ? "bg-warn" : "bg-faint")} />
                {slackLine(st)}
              </span>
            }
          >
            <Input value={f.slack} onChange={set("slack")} placeholder="#payments" />
          </Field>
          <Field label="GitHub repos" hint="One per line, like acme/payments-api." className="sm:row-span-2">
            <Textarea value={f.repos} onChange={set("repos")} rows={4} className="font-mono text-[13px]" placeholder="acme/payments-api" />
          </Field>
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <Field label="Timezone">
              {tzs.length ? (
                <Select value={f.tz} onChange={set("tz")}>
                  {!tzs.includes(f.tz) && <option value={f.tz}>{f.tz}</option>}
                  {tzs.map((z) => (
                    <option key={z} value={z}>
                      {z}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input value={f.tz} onChange={set("tz")} />
              )}
            </Field>
            <Field label="Brief at">
              <Select value={f.hour} onChange={set("hour")}>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="SSO groups" hint="People in these groups join the team when they sign in.">
            <Input value={f.sso} onChange={set("sso")} placeholder="eng-payments, payments-oncall" />
          </Field>
        </fieldset>
        {save.error && <ErrorLine error={errorLine(save.error)} className="sm:col-span-2" />}
        {canEdit && (
          <div className="sm:col-span-2 flex justify-end gap-2">
            {dirty && (
              <Button variant="ghost" onClick={() => setF(init())}>
                Discard
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={!dirty || !f.name.trim()} loading={save.isPending}>
              Save team
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}

function Members({ t }: { t: TeamDetail }) {
  const { data, isLoading, error } = useMembers(t.slug);
  const { data: me } = useMe();
  const [adding, setAdding] = useState(false);
  const canEdit = t.my_role === "admin" || me?.user?.role === "org_admin";
  const admins = (data ?? []).filter((m) => m.role === "admin").length;
  return (
    <Card>
      <CardHeader
        title="Members"
        sub={data ? `${data.length} ${data.length === 1 ? "person" : "people"} · ${admins} ${admins === 1 ? "admin" : "admins"}` : "Who is on this team."}
        right={
          canEdit && (
            <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
              Add member
            </Button>
          )
        }
      />
      <div className="px-5 pb-5">
        {error ? (
          <ErrorLine error={errorLine(error)} />
        ) : isLoading || !data ? (
          <SkeletonRows rows={3} />
        ) : data.length ? (
          <div className="-mx-5 -mb-5 border-t border-line divide-y divide-line">
            {data.map((m) => (
              <MemberRow key={m.user_id} t={t} m={m} canEdit={canEdit} self={m.user_id === me?.user?.id} lastAdmin={m.role === "admin" && admins === 1} />
            ))}
          </div>
        ) : (
          <div className="text-[14px] text-muted">No one yet. Add people by email.</div>
        )}
      </div>
      <AddMember t={t} open={adding} onClose={() => setAdding(false)} />
    </Card>
  );
}

function MemberRow({ t, m, canEdit, self, lastAdmin }: { t: TeamDetail; m: Member; canEdit: boolean; self: boolean; lastAdmin: boolean }) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();
  const role = useMutation({
    mutationFn: (r: TeamRole) => api.patchMember(t.slug, m.user_id, r),
    onSuccess: (x) => {
      invalidate(...TEAM_KEYS);
      toast({ title: x.role === "admin" ? `${m.name} is a team admin` : `${m.name} is a member`, icon: "✅" });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.removeMember(t.slug, m.user_id),
    onSuccess: () => {
      setConfirm(false);
      invalidate(...TEAM_KEYS);
      toast({ title: `${m.name} left ${t.name}`, icon: "👋" });
    },
  });
  const err = role.error ?? (confirm ? null : remove.error);
  return (
    <div className="flex items-center gap-3 px-5 py-2.5">
      <Avatar name={m.name} url={m.avatar_url} />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium truncate">
          {m.name}
          {self && <span className="ml-1.5 text-[12px] font-normal text-muted">you</span>}
        </div>
        <div className="text-[12px] text-muted truncate">{m.email}</div>
        {err && <div className="text-[12px] text-bad mt-0.5">{errorLine(err)}</div>}
      </div>
      {m.role === "admin" ? <Badge>Team admin</Badge> : <span className="text-[12px] text-muted">Member</span>}
      {canEdit && (
        <RowMenu open={menu} setOpen={setMenu} label={`Actions for ${m.name}`}>
          <MenuItem
            disabled={role.isPending || (lastAdmin && m.role === "admin")}
            onClick={() => {
              setMenu(false);
              role.mutate(m.role === "admin" ? "member" : "admin");
            }}
          >
            {m.role === "admin" ? "Make member" : "Make team admin"}
          </MenuItem>
          <MenuItem
            danger
            disabled={lastAdmin}
            onClick={() => {
              setMenu(false);
              remove.reset();
              setConfirm(true);
            }}
          >
            Remove from team…
          </MenuItem>
        </RowMenu>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => remove.mutate()}
        busy={remove.isPending}
        error={remove.error ? errorLine(remove.error) : null}
        title={`Remove ${m.name}?`}
        line={`${m.name} stops seeing ${t.name} in Keel. Their account stays.`}
        confirmLabel="Remove"
      />
    </div>
  );
}

function AddMember({ t, open, onClose }: { t: TeamDetail; open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const invalidate = useInvalidate();
  const toast = useToast();
  const add = useMutation({
    mutationFn: () => api.addMember(t.slug, { email: email.trim(), role }),
    onSuccess: (m) => {
      invalidate(...TEAM_KEYS);
      toast({ title: `${m.name} joined ${t.name}`, icon: "👋" });
      setEmail("");
      setRole("member");
      onClose();
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
      title={`Add someone to ${t.name}`}
      sub="They need a Keel account. Invite new people from People."
      width={440}
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" form="add-member" type="submit" loading={add.isPending} disabled={!email.includes("@")}>
            Add
          </Button>
        </>
      }
    >
      <form
        id="add-member"
        className="grid grid-cols-[1fr_140px] gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.includes("@")) add.mutate();
        }}
      >
        <Field label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" data-autofocus />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
            <option value="member">Member</option>
            <option value="admin">Team admin</option>
          </Select>
        </Field>
      </form>
      {add.error && <ErrorLine error={errorLine(add.error)} className="mt-3" />}
    </Dialog>
  );
}

function DangerZone({ t }: { t: TeamDetail }) {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const toast = useToast();
  const del = useMutation({
    mutationFn: () => api.deleteTeam(t.slug),
    onSuccess: () => {
      setOpen(false);
      invalidate("teams", "overview", "people", "audit", "commitments", "approvals");
      toast({ title: `${t.name} was deleted`, icon: "🗑️" });
      navigate("/", { replace: true });
    },
  });
  if (t.my_role !== "admin" && me?.user?.role !== "org_admin") return null;
  return (
    <Card className="border-bad/30">
      <div className="px-5 py-4 flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">Delete team</div>
          <div className="text-[12px] text-muted">Removes {t.name}, its steward, ledger, knowledge and services. This can't be undone.</div>
        </div>
        <Button
          variant="danger"
          onClick={() => {
            setTyped("");
            del.reset();
            setOpen(true);
          }}
        >
          Delete team…
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete ${t.name}?`}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={typed !== t.slug} loading={del.isPending} onClick={() => del.mutate()}>
              Delete team
            </Button>
          </>
        }
      >
        <div className="text-[14px] text-soft">
          {t.steward.emoji} {t.steward.name} stops, and everything {t.name} has in Keel is removed. Type <code className="font-mono text-fg">{t.slug}</code> to confirm.
        </div>
        <Input className="mt-3 font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={t.slug} aria-label="Team slug" data-autofocus />
        {del.error && <ErrorLine error={errorLine(del.error)} className="mt-3" />}
      </Dialog>
    </Card>
  );
}
