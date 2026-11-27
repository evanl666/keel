// Mock data for promise checks, Team Wrapped and checkup share images. Shapes follow keel/promises.py and keel/wrapped.py.
import type { CheckupReport, FoundPromise, PromiseReport, PromiseStatus, WrappedFacts } from "../types";
import { badge, card, colorForGrade, colorForRate } from "./svg";

const DAY = 86_400_000;
const STATUS_LABEL: Record<PromiseStatus, string> = {
  kept: "kept",
  overdue: "overdue",
  quiet: "gone quiet",
  dropped: "dropped",
  follow_up: "follow-up",
  open: "open",
};

// who, quote, days ago, number, is PR, what, due offset (days after the comment), deferred, status, days to keep
type Row = [string, string, number, number, boolean, string, number | null, boolean, PromiseStatus, number | null];
const DEMO: Row[] = [
  ["jonas-b", "I'll fix the rounding bug by Friday.", 23, 412, false, "Fix invoice rounding", 3, false, "overdue", null],
  ["maya-p", "On it, PR coming this afternoon.", 19, 431, true, "Send the idempotency PR", null, false, "kept", 0.3],
  ["iris-c", "I'll update the migration guide in a follow-up.", 17, 433, true, "Update the guide", null, true, "follow_up", null],
  ["theo-w", "I'll take a look at the flaky deploy test.", 26, 398, false, "Fix the flaky deploy test", null, false, "quiet", null],
  ["lena-o", "I'll take this one, should be done tomorrow.", 12, 445, false, "Ship refunds export", 1, false, "kept", 1.5],
  ["sam-o", "We'll bump the node image next week.", 15, 440, false, "Bump the node image", 7, false, "kept", 6],
  ["ravi-k", "Let me dig into the Android crash today.", 4, 452, false, "Debug the Android crash", 0, false, "overdue", null],
  ["kai-t", "I'll write the dark-mode spec.", 9, 449, false, "Write the dark-mode spec", null, false, "open", null],
  ["jonas-b", "I'll add a regression test for this.", 20, 420, true, "Add a regression test", null, false, "kept", 0.1],
  ["nora-l", "I'll send the release notes Monday.", 8, 447, false, "Send release notes", 4, false, "overdue", null],
];

const rateText = (r: number | null) => (r === null ? "n/a" : `${Math.round(r * 100)}%`);
const num = (x: number) => String(Number(x.toFixed(2)));

export function promiseReport(repo: string, days: number): PromiseReport {
  const now = Date.now();
  const promises: FoundPromise[] = DEMO.map(([who, quote, ago, number, isPr, what, due, deferred, status, keep]) => {
    const said = now - ago * DAY;
    return {
      who,
      quote,
      said_at: new Date(said).toISOString(),
      url: `https://github.com/${repo}/${isPr ? "pull" : "issues"}/${number}`,
      number,
      thread_title: what,
      is_pr: isPr,
      what,
      due: due === null ? null : new Date(said + due * DAY).toISOString().slice(0, 10),
      deferred,
      status,
      resolved_at: keep === null ? null : new Date(said + keep * DAY).toISOString(),
      days_to_keep: keep,
      age_days: ago,
    };
  });
  const count = (s: PromiseStatus) => promises.filter((p) => p.status === s).length;
  const kept = promises.filter((p) => p.status === "kept");
  const judged = promises.length - count("open") - count("follow_up");
  const keeps = kept.map((p) => p.days_to_keep ?? 0).sort((a, b) => a - b);
  const mid = keeps.length ? (keeps.length % 2 ? keeps[(keeps.length - 1) / 2] : (keeps[keeps.length / 2 - 1] + keeps[keeps.length / 2]) / 2) : null;
  const by = new Map<string, { who: string; made: number; kept: number }>();
  for (const p of promises) {
    const e = by.get(p.who) ?? { who: p.who, made: 0, kept: 0 };
    e.made += 1;
    if (p.status === "kept") e.kept += 1;
    by.set(p.who, e);
  }
  const unkept = promises.filter((p) => p.status === "overdue" || p.status === "quiet").sort((a, b) => b.age_days - a.age_days);
  const stats = {
    promises: promises.length,
    kept: kept.length,
    overdue: count("overdue"),
    quiet: count("quiet"),
    dropped: count("dropped"),
    follow_up: count("follow_up"),
    open: count("open"),
    judged,
    kept_rate: judged ? kept.length / judged : null,
    median_days_to_keep: mid === null ? null : Number(mid.toFixed(1)),
    top_promisers: [...by.values()].sort((a, b) => b.made - a.made || b.kept - a.kept || a.who.localeCompare(b.who)).slice(0, 3),
    oldest_unkept: unkept[0] ?? null,
    fastest_kept: [...kept].sort((a, b) => (a.days_to_keep ?? 0) - (b.days_to_keep ?? 0))[0] ?? null,
  };
  const report = {
    repo,
    days,
    scanned_comments: 318,
    checked_threads: 10,
    promises,
    used_model: false,
    stats,
    not_checked: ["mock data: a sample report, not a real scan"],
  };
  const st = stats;
  const rows: [string, string][] = [
    ["Promises found", `${st.promises} in ${report.scanned_comments} comments`],
    ["Kept", String(st.kept)],
    ["Late, quiet or dropped", String(st.overdue + st.quiet + st.dropped)],
  ];
  if (st.median_days_to_keep !== null) rows.push(["Median time to keep", `${num(st.median_days_to_keep)} days`]);
  const old = st.oldest_unkept;
  const late = [...unkept];
  const md = [
    `### ⚓ Promise check: ${repo} (last ${days} days)`,
    "",
    `**${rateText(st.kept_rate)} kept** · ${st.promises} promises in ${report.scanned_comments} comments · ` +
      `${st.kept} kept, ${st.overdue} overdue, ${st.quiet} gone quiet, ${st.dropped} dropped, ${st.follow_up} follow-ups, ${st.open} still open`,
    "",
    ...(late.length
      ? [
          "| Who | Promise | Said | Status |",
          "|---|---|---|---|",
          ...late.map((p) => `| @${p.who} | [${p.what.replace(/\|/g, "\\|")}](${p.url}) | ${Math.round(p.age_days)} days ago | ${STATUS_LABEL[p.status]} |`),
          "",
        ]
      : []),
    `<sub>Kept means the issue or PR closed as completed after the promise. Not checked: ${report.not_checked.join("; ")}.</sub>`,
  ].join("\n");
  return {
    ...report,
    badge_svg: badge("promises kept", rateText(st.kept_rate), colorForRate(st.kept_rate)),
    card_svg: card({
      eyebrow: `Promise check · last ${days} days`,
      title: repo,
      big: st.kept_rate === null ? "—" : rateText(st.kept_rate),
      bigCaption: st.kept_rate === null ? "nothing to judge yet" : "of promises kept",
      rows,
      quote: old ? `“${old.quote}” (${Math.round(old.age_days)} days, no update)` : "",
      accent: st.kept_rate === null ? undefined : colorForRate(st.kept_rate),
    }),
    markdown: md,
  };
}

type Facts = Omit<WrappedFacts, "team" | "days" | "from" | "to">;
const WRAPPED: Record<string, Facts> = {
  payments: {
    made: 14, kept: 8, on_time: 8, on_time_rate: 1, dropped: 0, overdue_now: 1, longest_on_time_streak: 8, helped_other_teams: 3,
    fastest: { key: "C-109", title: "Fix duplicate receipt emails", hours: 4.8 },
    best_partner: { team: "Platform", count: 4 },
    top_closers: [{ who: "Maya Chen", kept: 4 }, { who: "Priya Nair", kept: 2 }, { who: "Diego Ramos", kept: 2 }],
    busiest_day: "Saturday",
    oldest_open: { key: "C-82", title: "Publish Q4 PCI evidence pack", days: 16 },
    persona: { name: "The Closers", line: "Say it, ship it. Almost everything landed on time." },
    headline: "Eight for eight on time. Platform had your back four times.",
  },
  platform: {
    made: 12, kept: 7, on_time: 6, on_time_rate: 0.857, dropped: 0, overdue_now: 1, longest_on_time_streak: 3, helped_other_teams: 5,
    fastest: { key: "C-112", title: "Grant Mobile a staging namespace", hours: 9.6 },
    best_partner: { team: "Payments", count: 4 },
    top_closers: [{ who: "Lena Fischer", kept: 4 }, { who: "Sam Okafor", kept: 3 }],
    busiest_day: "Friday",
    oldest_open: { key: "C-83", title: "Upgrade ledger-db from Postgres 15 to 16", days: 20 },
    persona: { name: "The Good Neighbours", line: "A big share of the wins were other teams' asks." },
    headline: "A big share of the wins were other teams' asks.",
  },
  mobile: {
    made: 7, kept: 4, on_time: 3, on_time_rate: 0.75, dropped: 0, overdue_now: 1, longest_on_time_streak: 3, helped_other_teams: 1,
    fastest: { key: "C-117", title: "Hotfix: login loop on iOS 19", hours: 0.7 },
    best_partner: { team: "Platform", count: 3 },
    top_closers: [{ who: "Kenji Watanabe", kept: 3 }, { who: "Ana Lima", kept: 1 }],
    busiest_day: "Thursday",
    oldest_open: { key: "C-85", title: "Fix crash on Android 15 checkout sheet", days: 10 },
    persona: { name: "The Speedrunners", line: "Some asks were done before the thread went cold." },
    headline: "Some asks were done before the thread went cold.",
  },
};

const QUIET: Facts = {
  made: 0, kept: 0, on_time: 0, on_time_rate: null, dropped: 0, overdue_now: 0, longest_on_time_streak: 0, helped_other_teams: 0,
  fastest: null, best_partner: null, top_closers: [], busiest_day: null, oldest_open: null,
  persona: { name: "The Fresh Start", line: "A quiet month. Next month's story starts with the first promise." },
  headline: "A quiet month. Next month's story starts with the first promise.",
};

const day = (t: number) => new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).replace(",", "");

export function wrappedFacts(slug: string, team: string, days: number): WrappedFacts {
  const now = Date.now();
  return { team, days, from: day(now - days * DAY), to: day(now), ...(WRAPPED[slug] ?? QUIET) };
}

export function wrappedCard(f: WrappedFacts) {
  const rate = f.on_time_rate;
  const rows: [string, string][] = [["Promises", `${f.kept} kept · ${f.made} new`]];
  if (f.fastest) rows.push(["Fastest close", `${f.fastest.key} in ${f.fastest.hours < 1 ? `${Math.round(f.fastest.hours * 60)} min` : `${num(f.fastest.hours)} h`}`]);
  if (f.best_partner) rows.push(["Best partner", `${f.best_partner.team} (${f.best_partner.count})`]);
  rows.push(["This month you were", f.persona.name]);
  return card({
    eyebrow: `Team Wrapped · ${f.from} → ${f.to}`,
    title: f.team,
    big: rate === null ? "—" : `${Math.round(rate * 100)}%`,
    bigCaption: rate === null ? "nothing closed yet" : "kept on time",
    rows,
    quote: f.headline || f.persona.line,
    accent: rate === null ? undefined : colorForRate(rate),
  });
}

export const checkupBadge = (r: CheckupReport) => badge("keel checkup", `${r.grade} · ${r.score}`, colorForGrade(r.grade ?? "F"));

export function checkupCard(r: CheckupReport) {
  const st = r.stats as Record<string, string | number>;
  const top = r.findings[0]?.title;
  return card({
    eyebrow: "Repo checkup",
    title: r.repo,
    big: r.grade ?? "—",
    bigCaption: `${r.score}/100 · ${r.findings.length} finding${r.findings.length === 1 ? "" : "s"}`,
    rows: Object.entries(st)
      .slice(0, 4)
      .map(([k, v]) => [k, String(v)]),
    quote: top ? `Fix first: ${top}` : "Nothing to fix. This repo is in good shape.",
    accent: colorForGrade(r.grade ?? "F"),
  });
}
