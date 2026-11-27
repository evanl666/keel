import { useState } from "react";
import { errorLine } from "../../api/client";
import { usePatchSteward } from "../../api/hooks";
import type { Duty, TeamDetail } from "../../api/types";
import { Button, Card, CardHeader, Field, Input, Switch } from "../../components/ui";
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
    <div className="grid grid-cols-12 gap-5">
      <Card className="col-span-5 self-start">
        <CardHeader title="Identity" sub="How the steward shows up in Slack and here." />
        <div className="px-5 pb-5 space-y-4">
          <div className="flex items-center gap-4">
            <StewardAvatar emoji={emoji} color={t.color} size="lg" paused={t.steward.paused} />
            <div className="flex-1">
              <Field label="Name">
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={24} />
              </Field>
            </div>
          </div>
          <div>
            <div className="text-[12.5px] font-medium text-muted mb-1.5">Avatar</div>
            <div className="grid grid-cols-6 gap-1.5">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => setEmoji(e)}
                  className={cn("h-9 rounded-lg border text-[18px] grid place-items-center cursor-pointer transition-all", emoji === e ? "border-accent bg-accent-soft scale-105" : "border-line bg-sunken hover:border-line-strong")}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>
      <Card className="col-span-7">
        <CardHeader title="Duties" sub="Turn off what this team doesn't need. The steward stops that work right away." />
        <div className="px-5 pb-2">
          {ALL_DUTIES.map((d) => {
            const on = duties.includes(d.id);
            return (
              <div key={d.id} className="flex items-center gap-3 py-3 border-t border-line first:border-t-0">
                <span className="text-[18px] w-7 text-center">{DUTY_META[d.id].icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-[13.5px] font-medium">{DUTY_META[d.id].label}</div>
                  <div className="text-[12.5px] text-muted">{on ? d.line : "Off. The steward skips this."}</div>
                </div>
                <Switch checked={on} color={t.color} label={DUTY_META[d.id].label} onChange={(v) => setDuties((ds) => (v ? ALL_DUTIES.map((x) => x.id).filter((x) => x === d.id || ds.includes(x)) : ds.filter((x) => x !== d.id)))} />
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
    </div>
  );
}
