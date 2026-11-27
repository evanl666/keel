import { chromium } from "playwright";
const base = "http://localhost:8431";
const paths = ["/", "/teams/payments", "/teams/payments/ledger", "/teams/payments/front-desk", "/teams/platform/services",
  "/teams/payments/knowledge", "/teams/payments/level", "/teams/platform/settings", "/ledger", "/ledger?view=board",
  "/commitments/C-88", "/approvals", "/operations", "/services", "/checkup", "/audit", "/setup"];
const out = process.argv[2];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
console.log(problems.length ? problems.join("\n") : "NO PROBLEMS");
await browser.close();
