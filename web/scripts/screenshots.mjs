// Screenshots of every page in dark and light themes, plus a horizontal-overflow check.
// Usage: node scripts/screenshots.mjs [baseUrl] [--only=name,name] [--theme=dark|light] [--viewport=390x844] [--no-shots]
// Expects the app running in mock mode (npm run dev:mock).
// With a non-default --viewport, files are named <shot>-<theme>-<W>x<H>.png.
// Every page is checked for horizontal overflow (document or #main wider than the viewport);
// offenders are listed at the end and the script exits with code 1. --no-shots runs only the check.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:5173").replace(/\/$/, "");
const only = args.find((a) => a.startsWith("--only="))?.slice(7).split(",");
const themeArg = args.find((a) => a.startsWith("--theme="))?.slice(8);
const viewportArg = args.find((a) => a.startsWith("--viewport="))?.slice(11);
const noShots = args.includes("--no-shots");
const outDir = fileURLToPath(new URL("../screenshots/", import.meta.url));
const [W, H] = viewportArg ? viewportArg.split("x").map(Number) : [1440, 900];
if (!W || !H) throw new Error(`bad --viewport ${viewportArg}, expected WxH like 390x844`);
const suffix = viewportArg ? `-${W}x${H}` : "";
const mobile = W < 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** @type {{name: string, path: string, signedOut?: boolean, full?: boolean, mobileOnly?: boolean, act?: (page: import('playwright').Page) => Promise<void>}[]} */
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
  { name: "team-learning", path: "/teams/payments/learning", full: true },
  {
    name: "team-learning-diff",
    path: "/teams/payments/learning",
    act: async (p) => {
      await p.getByRole("button", { name: /A better reply to/ }).click();
      await sleep(500);
    },
  },
  { name: "team-learning-empty", path: "/teams/mobile/learning" },
  { name: "team-level", path: "/teams/payments/level" },
  { name: "team-settings", path: "/teams/platform/settings" },
  { name: "ledger", path: "/ledger", full: true },
  { name: "ledger-board", path: "/ledger?view=board", full: true },
  { name: "commitment", path: "/commitments/C-88", full: true },
  { name: "approvals", path: "/approvals", full: true },
  {
    name: "approvals-rejecting",
    path: "/approvals",
    act: async (p) => {
      await p.keyboard.press("r");
      await sleep(300);
      await p.getByRole("button", { name: "Wrong team" }).first().click();
      await sleep(300);
    },
  },
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
  { name: "promises", path: "/promises" },
  {
    name: "promises-running",
    path: "/promises",
    act: async (p) => {
      await p.getByLabel("GitHub repository").fill("vercel/next.js");
      await p.getByRole("button", { name: "Check promises" }).click();
      await sleep(1500);
    },
  },
  {
    name: "promises-result",
    path: "/promises?repo=acme/payments&days=30",
    full: true,
    act: async (p) => {
      await p.getByText("of promises kept", { exact: false }).first().waitFor();
      await sleep(600);
    },
  },
  { name: "overview-full", path: "/", full: true },
  ...[0, 1, 2, 3, 4, 5].map((n) => ({
    name: `wrapped-${n + 1}`,
    path: "/teams/payments?wrapped=1",
    act: async (p) => {
      await p.getByRole("dialog").waitFor();
      await sleep(400);
      // Pause auto-advance so the shot shows the slide we stepped to.
      await p.keyboard.press("Space");
      for (let i = 0; i < n; i++) {
        await p.keyboard.press("ArrowRight");
        await sleep(250);
      }
      await sleep(1800);
    },
  })),
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
  { name: "not-found", path: "/no-such-page" },
  {
    name: "menu",
    path: "/",
    mobileOnly: true,
    act: async (p) => {
      await p.getByRole("button", { name: "Open menu" }).click();
      await sleep(500);
    },
  },
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
const overflows = [];
const browser = await chromium.launch();
const themes = themeArg ? [themeArg] : ["dark", "light"];
for (const theme of themes) {
  for (const s of shots) {
    if (only && !only.includes(s.name)) continue;
    if (s.mobileOnly && !mobile) continue;
    const ctx = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: mobile ? 2 : 1,
      colorScheme: theme,
      hasTouch: W < 768,
      isMobile: W < 768,
    });
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
    page.setDefaultTimeout(8000);
    if (s.act) {
      try {
        await s.act(page);
      } catch (e) {
        console.error(`[${s.name}] action failed:`, e.message.split("\n")[0]);
      }
    }
    const over = await page.evaluate(() => {
      const vw = window.innerWidth;
      const docW = document.documentElement.scrollWidth;
      const m = document.getElementById("main");
      const mainOver = m ? m.scrollWidth - m.clientWidth : 0;
      if (docW <= vw && mainOver <= 0) return null;
      // Name the widest leaf-ish elements that stick out past the right edge, skipping
      // anything inside an intentional horizontal scroller.
      const culprits = [];
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.right <= vw + 1 || r.width === 0) continue;
        let p = el.parentElement, scrolled = false;
        while (p && p !== document.body) {
          const ox = getComputedStyle(p).overflowX;
          if ((ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") && p.id !== "main") { scrolled = true; break; }
          p = p.parentElement;
        }
        if (scrolled) continue;
        const cls = typeof el.className === "string" ? el.className.slice(0, 80) : "";
        culprits.push(`${el.tagName.toLowerCase()}.${cls} right=${Math.round(r.right)}`);
        if (culprits.length >= 6) break;
      }
      return { vw, docW, mainOver, culprits };
    });
    if (over) {
      overflows.push({ name: s.name, theme, ...over });
      console.warn(`[${s.name}] OVERFLOW doc=${over.docW} main+${over.mainOver} viewport=${over.vw}`);
    }
    if (noShots) {
      await ctx.close();
      continue;
    }
    // Phone and tablet pages are long; capture them whole unless the shot is an overlay.
    if (s.full || (mobile && !s.act)) {
      const h = await page.evaluate(() => {
        const m = document.getElementById("main");
        // Anything outside #main (e.g. the phone top bar) adds to the height we need.
        return m ? m.scrollHeight + (window.innerHeight - m.clientHeight) : document.documentElement.scrollHeight;
      });
      if (h > H) {
        await page.setViewportSize({ width: W, height: Math.min(h, mobile ? 6000 : 3200) });
        await sleep(500);
      }
    }
    const file = `${outDir}${s.name}-${theme}${suffix}.png`;
    await page.screenshot({ path: file });
    console.log("saved", file.replace(outDir, "screenshots/"));
    await ctx.close();
  }
}
await browser.close();
if (overflows.length) {
  console.log(`\nHorizontal overflow at ${W}x${H}:`);
  for (const o of overflows) {
    console.log(`  ${o.name} (${o.theme}): scrollWidth ${o.docW}, #main +${o.mainOver}px, innerWidth ${o.vw}`);
    for (const c of o.culprits) console.log(`    ${c}`);
  }
  process.exitCode = 1;
} else {
  console.log(`\nNo horizontal overflow at ${W}x${H}.`);
}
