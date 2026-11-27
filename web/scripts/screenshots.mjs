// Screenshots of every page in dark and light themes.
// Usage: node scripts/screenshots.mjs [baseUrl] [--only=name,name] [--theme=dark|light]
// Expects the app running in mock mode (npm run dev:mock).
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:5173").replace(/\/$/, "");
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const themeArg = args.find((a) => a.startsWith("--theme="))?.slice(8);
const outDir = fileURLToPath(new URL("../screenshots/", import.meta.url));
const W = 1440;
const H = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {{name: string, path: string, signedOut?: boolean, full?: boolean, act?: (page: import('playwright').Page) => Promise<void>}[]} */
const shots = [
  { name: "overview", path: "/" },
  { name: "team-today", path: "/teams/payments", full: true },
  { name: "team-ledger", path: "/teams/payments/ledger", full: true },
  {
    name: "team-front-desk",
    path: "/teams/payments/front-desk",
    act: async (p) => {
      await p.getByRole("button", { name: "PCI scope" }).click();
      await sleep(900);
    },
  },
  { name: "team-services", path: "/teams/payments/services", full: true },
  { name: "team-knowledge", path: "/teams/payments/knowledge" },
  { name: "team-level", path: "/teams/payments/level" },
  { name: "team-settings", path: "/teams/platform/settings" },
  { name: "ledger", path: "/ledger", full: true },
  { name: "ledger-board", path: "/ledger?view=board", full: true },
  { name: "commitment", path: "/commitments/C-88", full: true },
  { name: "approvals", path: "/approvals", full: true },
  {
    name: "approvals-editing",
    path: "/approvals",
    act: async (p) => {
      await p.keyboard.press("e");
      await sleep(400);
    },
  },
  { name: "operations", path: "/operations", full: true },
  { name: "services", path: "/services", full: true },
  { name: "checkup", path: "/checkup?id=ck_1", full: true },
  {
    name: "checkup-running",
    path: "/checkup",
    act: async (p) => {
      await p.getByLabel("GitHub repository").fill("acme/mobile-app");
      await p.getByRole("button", { name: "Run checkup" }).click();
      await sleep(2600);
    },
  },
  { name: "audit", path: "/audit", full: true },
  { name: "setup", path: "/setup" },
  {
    name: "setup-slack",
    path: "/setup",
    act: async (p) => {
      await p.getByRole("button", { name: /Slack/ }).first().click();
      await sleep(300);
      await p.getByPlaceholder("xoxb-…").fill("xoxb-123");
      await p.getByPlaceholder("xapp-…").fill("bad-token");
      await p.getByRole("button", { name: "Test" }).click();
      await sleep(700);
    },
  },
  { name: "login", path: "/login", signedOut: true },
  {
    name: "palette",
    path: "/",
    act: async (p) => {
      await p.keyboard.press("Meta+k");
      await sleep(250);
      await p.keyboard.type("c-8");
      await sleep(400);
    },
  },
  {
    name: "shortcuts",
    path: "/ledger",
    act: async (p) => {
      await p.keyboard.press("Shift+?");
      await sleep(400);
    },
  },
];

await mkdir(outDir, { recursive: true });
const browser = await chromium.launch();
const themes = themeArg ? [themeArg] : ["dark", "light"];
for (const theme of themes) {
  for (const s of shots) {
    if (only && !only.includes(s.name)) continue;
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: theme });
    await ctx.addInitScript(
      ([t, out]) => {
        localStorage.setItem("keel-theme", t);
        if (out) localStorage.setItem("keel-mock-signed-out", "1");
        else localStorage.removeItem("keel-mock-signed-out");
      },
      [theme, !!s.signedOut],
    );
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`[${s.name}] page error:`, e.message));
    await page.goto(base + s.path, { waitUntil: "networkidle" });
    await sleep(1600);
    if (s.act) await s.act(page);
    if (s.full) {
      const h = await page.evaluate(() => {
        const m = document.getElementById("main");
        return m ? m.scrollHeight : document.documentElement.scrollHeight;
      });
      if (h > H) {
        await page.setViewportSize({ width: W, height: Math.min(h, 3200) });
        await sleep(500);
      }
    }
    const file = `${outDir}${s.name}-${theme}.png`;
    await page.screenshot({ path: file });
    console.log("saved", file.replace(outDir, "screenshots/"));
    await ctx.close();
  }
}
await browser.close();
