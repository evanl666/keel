import { chromium } from "playwright";
const base = "http://localhost:8431";
const paths = ["/", "/teams/payments", "/teams/payments/ledger", "/teams/payments/front-desk", "/teams/platform/services",
  "/teams/payments/knowledge", "/teams/payments/level", "/teams/platform/settings", "/ledger", "/ledger?view=board",
  "/commitments/C-88", "/approvals", "/operations", "/services", "/checkup", "/promises", "/audit", "/setup"];
const out = process.argv[2];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
const problems = [];
page.on("console", (m) => { if (m.type() === "error") problems.push(`console ${page.url()}: ${m.text().slice(0, 200)}`); });
page.on("pageerror", (e) => problems.push(`pageerror ${page.url()}: ${e.message.slice(0, 200)}`));
page.on("response", async (r) => { if (r.url().includes("/api/") && r.status() >= 400) problems.push(`api ${r.status()} ${r.request().method()} ${r.url()} ${(await r.text().catch(() => "")).slice(0, 150)}`); });
for (const p of paths) {
  await page.goto(base + p, { waitUntil: "networkidle" }).catch((e) => problems.push(`goto ${p}: ${e.message}`));
  await page.waitForTimeout(700);
  const name = p === "/" ? "overview" : p.slice(1).replace(/[/?=]/g, "-");
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  const text = await page.innerText("body");
  if (/undefined|NaN|\[object Object\]/.test(text)) problems.push(`text ${p}: ${text.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/)?.[0]}`);
}
// interactions: play the story, approve, chat, checkup
await page.goto(base + "/", { waitUntil: "networkidle" });
for (let i = 0; i < 3; i++) {
  const btn = page.getByRole("button", { name: /play|next event/i }).first();
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(1500); } else { problems.push("no play button"); break; }
}
await page.screenshot({ path: `${out}/overview-after-story.png` });
await page.goto(base + "/teams/payments/front-desk", { waitUntil: "networkidle" });
const box = page.getByPlaceholder(/^Message /).first(); await box.waitFor({ timeout: 8000 }).catch(() => problems.push("no chat textarea"));
await box.fill("How do we rotate the webhook secret?"); await box.press("Enter"); await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/front-desk-answer.png` });
await page.goto(base + "/approvals", { waitUntil: "networkidle" });
const before = await page.getByRole("button", { name: /^approve/i }).count();
if (before) { await page.getByRole("button", { name: /^approve/i }).first().click(); await page.waitForTimeout(1500); }
const after = await page.getByRole("button", { name: /^approve/i }).count();
console.log(`approve buttons ${before} -> ${after}`);
await page.goto(base + "/checkup", { waitUntil: "networkidle" });
const repo = page.locator("input").first(); await repo.fill("acme/api"); await repo.press("Enter"); await page.waitForTimeout(3000);
await page.screenshot({ path: `${out}/checkup-run.png`, fullPage: true });
// checkup share: wait for the report, then download the badge and copy its Markdown
const expectDownload = async (label, click, pattern) => {
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), click()]).catch((e) => { problems.push(`${label}: no download (${e.message.split("\n")[0]})`); return []; });
  if (dl) { const name = dl.suggestedFilename(); console.log(`${label}: downloaded ${name}`); if (!pattern.test(name)) problems.push(`${label}: unexpected filename ${name}`); }
};
const badgeBtn = page.getByRole("button", { name: "Download badge" });
await badgeBtn.waitFor({ timeout: 90000 }).catch(() => problems.push("checkup never offered Download badge"));
if (await badgeBtn.count()) {
  await expectDownload("checkup badge", () => badgeBtn.click(), /^acme-api-checkup-badge\.svg$/);
  await expectDownload("checkup card", () => page.getByRole("button", { name: "Download share card" }).click(), /^acme-api-checkup-card\.svg$/);
  await page.getByRole("button", { name: "Copy badge Markdown" }).click();
  await page.waitForTimeout(300);
  const md = await page.evaluate(() => navigator.clipboard.readText());
  if (!/^\[!\[keel checkup\]\(http:\/\/localhost:8431\/api\/checkups\/[\w-]+\/badge\.svg\)\]/.test(md)) problems.push(`checkup badge markdown: ${md.slice(0, 120)}`);
  else console.log(`checkup badge markdown: ${md}`);
  const badgeUrl = md.match(/\((http[^)]+badge\.svg)\)/)?.[1];
  const res = badgeUrl && (await page.request.get(badgeUrl));
  if (!res || res.status() !== 200 || !(await res.text()).startsWith("<svg")) problems.push(`checkup badge url ${badgeUrl} -> ${res?.status()}`);
  await page.screenshot({ path: `${out}/checkup-share.png`, fullPage: true });
}
// promises: run the demo repo, filter, and use every share action
await page.goto(base + "/promises", { waitUntil: "networkidle" });
await page.getByLabel("GitHub repository").fill("acme/payments");
await page.getByRole("button", { name: "Check promises" }).click();
await page.getByText("of promises kept").first().waitFor({ timeout: 60000 }).catch(() => problems.push("promises report never showed"));
const rate = await page.getByText(/^\d+%$/).first().innerText().catch(() => "");
if (rate !== "50%") problems.push(`promises kept rate ${rate}, expected 50%`);
const rows = async () => page.getByRole("link", { name: /^Comment/ }).count();
const all = await rows();
await page.getByRole("button", { name: /^Overdue/ }).first().click();
const overdue = await rows();
console.log(`promises rows: all ${all}, overdue ${overdue}`);
if (all !== 10 || overdue !== 3) problems.push(`promises rows all=${all} overdue=${overdue}, expected 10/3`);
await page.getByRole("button", { name: /^All/ }).first().click();
await expectDownload("promises card", () => page.getByRole("button", { name: "Download share card" }).click(), /^acme-payments-promises-card\.svg$/);
await expectDownload("promises badge", () => page.getByRole("button", { name: "Download badge.svg" }).click(), /^acme-payments-promises-badge\.svg$/);
await page.getByRole("button", { name: "Copy Markdown summary" }).click();
await page.waitForTimeout(300);
const summary = await page.evaluate(() => navigator.clipboard.readText());
if (!summary.startsWith("### ⚓ Promise check: acme/payments")) problems.push(`promises summary: ${summary.slice(0, 80)}`);
await page.screenshot({ path: `${out}/promises-result.png`, fullPage: true });
const bad = await page.request.post(base + "/api/promises", { data: { repo: "not a repo", days: 30 } });
if (bad.status() !== 422) problems.push(`promises bad repo -> ${bad.status()}, expected 422`);
// Team Wrapped: open from the team header, step through every slide, download the card
await page.goto(base + "/teams/payments", { waitUntil: "networkidle" });
await page.getByRole("button", { name: /Wrapped/ }).first().click();
const story = page.getByRole("dialog", { name: /Wrapped/ });
await story.waitFor({ timeout: 30000 }).catch(() => problems.push("wrapped dialog never opened"));
if (!page.url().includes("wrapped=1")) problems.push(`wrapped url ${page.url()}`);
await page.getByText(/landed on time|nothing closed yet|kept on time/i).first().waitFor({ timeout: 60000 }).catch(() => problems.push("wrapped first slide never loaded"));
await page.keyboard.press("Space");
let slides = 1;
for (; slides < 10; slides++) {
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${out}/wrapped-${slides}.png` });
  const said = await story.innerText();
  if (/undefined|NaN|null|\[object Object\]/.test(said)) problems.push(`wrapped slide ${slides}: ${said.slice(0, 120)}`);
  if (await page.getByRole("button", { name: "Download card" }).count()) break;
  await page.keyboard.press("ArrowRight");
}
console.log(`wrapped slides: ${slides}`);
if (slides < 4 || slides > 6) problems.push(`wrapped had ${slides} slides`);
await page.getByRole("img", { name: /Wrapped share card/i }).waitFor({ timeout: 30000 }).catch(() => problems.push("wrapped card image never showed"));
await expectDownload("wrapped card", () => page.getByRole("button", { name: "Download card" }).click(), /^payments-wrapped.*\.svg$/);
await page.keyboard.press("ArrowLeft");
await page.waitForTimeout(500);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
if (await story.count()) problems.push("wrapped did not close on Escape");
if (page.url().includes("wrapped=1")) problems.push(`wrapped param left in ${page.url()}`);
await page.goto(base + "/", { waitUntil: "networkidle" });
await page.locator('a[href="/teams/platform?wrapped=1"]').click().catch((e) => problems.push(`overview wrapped link: ${e.message.split("\n")[0]}`));
await story.waitFor({ timeout: 30000 }).catch(() => problems.push("wrapped from overview never opened"));
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/wrapped-platform.png` });
console.log(problems.length ? problems.join("\n") : "NO PROBLEMS");
await browser.close();
