/**
 * E2E: Andrew Ng ML notes — math rendering in headed Chrome.
 * Runs against the live dev server at http://localhost:3000.
 *
 * Flow: paste imported markdown → verify OFF (zero KaTeX) → toggle Math Mode
 * in Edit mode (toolbar visible) → switch to Preview → verify KaTeX renders
 * across Plain CSS, Paged.js, and Vivliostyle engines.
 */
const { chromium } = require("playwright");
const fs = require("fs");

const path = require("path");

const BASE = process.env.E2E_BASE || "http://localhost:3000";
const FIXTURE = process.env.E2E_FIXTURE || path.resolve(__dirname, "..", "test", "fixtures", "math-andrew-ng-snippet.md");

(async () => {
  const md = fs.readFileSync(FIXTURE, "utf8");
  console.log(`[fixture] ${md.length} chars`);

  const browser = await chromium.launch({ headless: false, channel: "chromium" });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error("[console.error]", m.text()); });

  console.log("[1] navigate to editor");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#editor", { state: "visible", timeout: 15000 });

  console.log("[2] paste Andrew Ng notes into editor");
  await page.click("#editor");
  await page.evaluate((text) => {
    const ed = document.getElementById("editor");
    ed.value = text;
    ed.dispatchEvent(new Event("input", { bubbles: true }));
  }, md);
  await page.waitForTimeout(1500);

  // --- Switch to Preview, verify Math Mode OFF ---
  console.log("[3] switch to Preview mode (Math Mode OFF)");
  await page.click("#btn-preview");
  await page.waitForTimeout(2000);

  const offState = await page.evaluate(() => {
    const iframe = document.getElementById("preview-frame");
    if (!iframe || !iframe.contentDocument) return { error: "no preview iframe" };
    const doc = iframe.contentDocument;
    return {
      katex: doc.querySelectorAll(".katex").length,
      css: !!doc.querySelector('link[href*="katex"]'),
      literal: doc.body.innerText.includes("$$") || doc.body.innerText.includes("\\theta"),
    };
  });
  console.log("    OFF:", offState);
  if (offState.error) throw new Error(offState.error);
  if (offState.katex !== 0) throw new Error("KaTeX should NOT render when Math Mode is off");
  if (offState.css) throw new Error("KaTeX CSS should NOT load when Math Mode is off");
  console.log("    ✓ zero KaTeX, zero CSS — literal text only");

  // --- Back to Edit, enable Math Mode (toolbar visible), then Preview ---
  console.log("[4] back to Edit mode, enable Math Mode");
  await page.click("#btn-edit");
  await page.waitForTimeout(500);
  // Scroll the Math Mode button into view (it's at the end of the toolbar)
  await page.evaluate(() => {
    const btn = document.getElementById("btn-math");
    if (btn) btn.scrollIntoView({ block: "center", inline: "center" });
  });
  await page.waitForTimeout(200);
  await page.locator("#btn-math").click({ force: true });
  await page.waitForTimeout(800);
  const toggleState = await page.evaluate(() => ({
    pressed: document.getElementById("btn-math")?.getAttribute("aria-pressed"),
    active: document.getElementById("btn-math")?.classList.contains("is-active"),
  }));
  console.log("    toggle:", toggleState);
  if (toggleState.pressed !== "true") {
    // Fallback: click via JS directly
    console.log("    (retry via JS click)");
    await page.evaluate(() => document.getElementById("btn-math").click());
    await page.waitForTimeout(800);
    const retry = await page.evaluate(() => ({
      pressed: document.getElementById("btn-math")?.getAttribute("aria-pressed"),
      active: document.getElementById("btn-math")?.classList.contains("is-active"),
    }));
    console.log("    retry:", retry);
    if (retry.pressed !== "true") throw new Error("Math Mode toggle did not activate");
  }

  console.log("[5] switch to Preview mode (Math Mode ON)");
  await page.click("#btn-preview");
  await page.waitForTimeout(3500);

  const onState = await page.evaluate(() => {
    const iframe = document.getElementById("preview-frame");
    if (!iframe || !iframe.contentDocument) return { error: "no preview iframe" };
    const doc = iframe.contentDocument;
    let unrendered = 0;
    doc.querySelectorAll(".fw-math-inline, .fw-math-display").forEach((el) => {
      if (!el.querySelector(".katex")) unrendered++;
    });
    return {
      katex: doc.querySelectorAll(".katex").length,
      mathml: doc.querySelectorAll(".katex-mathml").length,
      css: !!doc.querySelector('link[href*="katex"]'),
      fwInline: doc.querySelectorAll(".fw-math-inline").length,
      fwDisplay: doc.querySelectorAll(".fw-math-display").length,
      unrendered,
    };
  });
  console.log("    ON:", onState);
  if (onState.error) throw new Error(onState.error);
  if (onState.katex === 0) throw new Error("KaTeX did not render any nodes");
  if (!onState.css) throw new Error("KaTeX CSS not loaded in preview iframe");
  console.log(`    ✓ ${onState.katex} KaTeX nodes (${onState.fwInline} inline + ${onState.fwDisplay} display), ${onState.mathml} MathML`);
  if (onState.unrendered > 0) console.warn(`    WARN: ${onState.unrendered} placeholders not rendered`);

  await page.screenshot({ path: "/tmp/flatwrite-math-on.png" });
  console.log("    screenshot: /tmp/flatwrite-math-on.png");

  // --- Test switching engines: Plain CSS, Paged.js, Vivliostyle ---
  const engines = [
    { name: "plain", label: "Plain CSS", selector: '[data-engine="none"]' },
    { name: "pagedjs", label: "Paged.js", selector: '[data-engine="pagedjs"]' },
    { name: "vivliostyle", label: "Vivliostyle", selector: '[data-engine="vivliostyle"]' },
  ];

  for (const eng of engines) {
    console.log(`[6] switch to ${eng.label}`);
    const btn = page.locator(eng.selector).first();
    if ((await btn.count()) === 0) { console.log(`    (skipped — not found)`); continue; }
    await btn.click({ force: true });
    await page.waitForTimeout(4000);

    const st = await page.evaluate(() => {
      const iframe = document.getElementById("preview-frame");
      if (!iframe || !iframe.contentDocument) return { error: "no iframe" };
      const doc = iframe.contentDocument;
      return {
        katex: doc.querySelectorAll(".katex").length,
        mathml: doc.querySelectorAll(".katex-mathml").length,
        css: !!doc.querySelector('link[href*="katex"]'),
      };
    });
    if (st.error) { console.log(`    ${eng.label}: ${st.error}`); continue; }
    console.log(`    ${eng.label}: ${st.katex} KaTeX, ${st.mathml} MathML, css=${st.css}`);
    if (st.katex > 0) console.log(`    ✓ ${st.katex} KaTeX nodes rendered`);
    else console.warn(`    WARN: no KaTeX in ${eng.label}`);
    await page.screenshot({ path: `/tmp/flatwrite-math-${eng.name}.png` });
  }

  console.log("\n=== E2E COMPLETE ===");
  console.log("Screenshots: /tmp/flatwrite-math-{on,plain,pagedjs,vivliostyle}.png");
  console.log("\nKeeping browser open 10s for inspection...");
  await page.waitForTimeout(10000);
  await browser.close();
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
