/* End-to-end browser test against the real backend + PostgreSQL.
   Two independent browser contexts = two devices on one account.
   run: NODE_PATH=/tmp/bmtest/node_modules node tests/e2e.test.js      */
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const CREDS = { username: "blue", email: "owner@bluemobile.ly", password: "ledger-2026-pass" };

let pass = 0, fail = 0;
const group = n => console.log("\n=== " + n + " ===");
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + label); }
  else { fail++; console.log("  \u2717 FAIL: " + label + (extra !== undefined ? "  \u2192 " + JSON.stringify(extra) : "")); }
};

/* make sure the single account exists, then wipe the ledger (not the account) */
async function resetLedger() {
  const status = await (await fetch(BASE + "/api/auth/status")).json();
  if (status.setupRequired) {
    await fetch(BASE + "/api/auth/setup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(CREDS)
    });
  }
  const login = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: CREDS.username, password: CREDS.password })
  });
  const { token } = await login.json();
  await fetch(BASE + "/api/data", {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ confirm: "DELETE" })
  });
}

/* read the server through the page's own session — no eval(), CSP-safe */
const apiIn = (page, path) => page.evaluate(
  p => fetch(p, { credentials: "same-origin", headers: { accept: "application/json" } }).then(r => r.json()),
  "/api" + path);

const waitHidden = async (page, sel) => {
  for (let i = 0; i < 100; i++) {
    const vis = await page.evaluate(s => document.querySelector(s).classList.contains("visible"), sel);
    if (!vis) return true;
    await page.waitForTimeout(100);
  }
  return false;
};

(async () => {
  await resetLedger();
  const browser = await chromium.launch();
  const errors = [];
  const newPhone = async (name, w = 420, h = 900) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(name + ": " + e.message));
    page.on("console", m => {
      /* the suite deliberately submits a wrong password, so its 401 is expected */
      if (m.type() === "error" && !/status of 401/.test(m.text())) errors.push(name + " console: " + m.text());
    });
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    return { ctx, page };
  };
  const login = async page => {
    await page.waitForSelector("#auth-screen.visible", { timeout: 10000 });
    await page.fill("#login-username", CREDS.username);
    await page.fill("#login-password", CREDS.password);
    await page.click("#auth-login-form button[type=submit]");
    await waitHidden(page, "#auth-screen");
  };

  /* ---------------- 1. sign-in gate ---------------- */
  group("1. The app is locked until you sign in");
  const A = await newPhone("Phone A");
  {
    await A.page.waitForSelector("#auth-screen.visible", { timeout: 10000 });
    check("sign-in screen shown on arrival", await A.page.isVisible("#auth-screen"));
    check("the ledger behind it is not usable", !(await A.page.isVisible("#sale-form")));
    check("sign-in screen is Arabic", (await A.page.textContent("#auth-title")).includes("تسجيل الدخول"),
      await A.page.textContent("#auth-title"));
    check("layout is RTL", await A.page.evaluate(() => document.documentElement.dir) === "rtl");
    check("no sign-up option is offered", !(await A.page.isVisible("#auth-setup-form")));

    await A.page.fill("#login-username", CREDS.username);
    await A.page.fill("#login-password", "definitely-wrong");
    await A.page.click("#auth-login-form button[type=submit]");
    await A.page.waitForTimeout(700);
    const err = await A.page.textContent("#auth-error");
    check("wrong password shows an Arabic error and stays locked",
      err.trim().length > 0 && await A.page.isVisible("#auth-screen"), err);

    await A.page.fill("#login-password", CREDS.password);
    await A.page.click("#auth-login-form button[type=submit]");
    await waitHidden(A.page, "#auth-screen");
    check("correct password opens the ledger", !(await A.page.isVisible("#auth-screen")));
    check("Arabic interface after sign-in",
      (await A.page.textContent('[data-nav="sales"] span')) === "المبيعات");
  }

  /* ---------------- 2. record a sale on Phone A ---------------- */
  group("2. Phone A: open a day and record a sale");
  {
    await A.page.click("#dash-start-day-btn");
    await A.page.waitForTimeout(400);
    await A.page.click("#modal-startday .btn-primary");
    await A.page.waitForTimeout(700);
    check("day opened through the API", (await apiIn(A.page, "/days")).days.length === 1);

    await A.page.click('.nav-item[data-nav="sales"]');
    await A.page.waitForTimeout(300);
    await A.page.fill("#sale-product", "جواء");
    await A.page.fill("#sale-wholesale", "15");
    await A.page.fill("#sale-price", "20");
    await A.page.fill("#sale-qty", "1");
    await A.page.click("#sale-submit-btn");
    await A.page.waitForTimeout(800);

    const sale = (await apiIn(A.page, "/sales")).sales[0];
    check("sale stored with server-calculated figures (1 x 20/15 -> 20/15/5)",
      sale.total === 20 && sale.cost === 15 && sale.profit === 5, sale);
    check("the form stopped — no new sale started",
      await A.page.evaluate(() => getComputedStyle(document.getElementById("sale-form")).display) === "none");
    check("nothing was focused (keyboard stays shut)",
      await A.page.evaluate(() => document.activeElement.tagName) === "BODY");

    await A.page.click("#new-sale-btn");
    await A.page.waitForTimeout(300);
    check("بيع جديد reopens a clean form",
      await A.page.evaluate(() => document.getElementById("sale-product").value) === "");
    check("and focuses the product field on request",
      await A.page.evaluate(() => document.activeElement.id) === "sale-product");

    await A.page.fill("#note-input", "أعطيت أخوي 100 د.ل");
    await A.page.click("#note-submit-btn");
    await A.page.waitForTimeout(600);
    check("daily note saved to the server", (await apiIn(A.page, "/notes")).notes.length === 1);
    check("the note is on screen", (await A.page.$$("#note-list .note-item")).length === 1);
    const totals = (await apiIn(A.page, "/sales/summary")).summary;
    check("note did not touch the totals", totals.total === 20 && totals.profit === 5 && totals.count === 1, totals);
  }

  /* ---------------- 3. Phone B sees everything ---------------- */
  group("3. Phone B: same account, another device");
  const B = await newPhone("Phone B");
  {
    await login(B.page);
    await B.page.waitForTimeout(600);
    const rows = await B.page.$$eval("#sales-tbody tr td:nth-child(2)", els => els.map(e => e.textContent.trim()));
    check("Phone B's ledger table shows the sale created on Phone A",
      rows.length === 1 && rows[0] === "جواء", rows);
    check("Phone B's screen shows the note",
      (await B.page.$$("#note-list .note-item")).length === 1);
    check("Phone B sees the open day",
      (await apiIn(B.page, "/days/current")).day.status === "open");

    /* autocomplete comes from the database, not this device */
    await B.page.click('.nav-item[data-nav="sales"]');
    await B.page.waitForTimeout(300);
    await B.page.click("#sale-product");
    await B.page.type("#sale-product", "ج", { delay: 80 });
    await B.page.waitForTimeout(600);
    const sug = await B.page.$$eval("#product-suggestions .ac-item:not(.is-new)", els => els.map(e => e.dataset.name));
    check('Phone B types "ج" and gets the name Phone A created', sug.includes("جواء"), sug);

    /* Phone B sells; Phone A must see it after a refresh */
    await B.page.fill("#sale-product", "شاحن من الجهاز الثاني");
    await B.page.fill("#sale-wholesale", "10");
    await B.page.fill("#sale-price", "25");
    await B.page.fill("#sale-qty", "2");
    await B.page.click("#sale-submit-btn");
    await B.page.waitForTimeout(800);
    check("Phone B's sale is stored (2 x 25/10 -> 50/20/30)",
      (await apiIn(B.page, "/sales")).sales[0].profit === 30);

    await A.page.reload({ waitUntil: "networkidle" });
    await A.page.waitForTimeout(900);
    const aRows = await A.page.$$eval("#sales-tbody tr td:nth-child(2)", els => els.map(e => e.textContent.trim()));
    check("Phone A (after reload) shows Phone B's sale in its ledger", aRows.length === 2, aRows);
    const sumA = (await apiIn(A.page, "/sales/summary")).summary;
    const liveTotal = await A.page.textContent("#live-summary");
    check("both devices agree on the daily total (70)", sumA.total === 70, sumA);
    check("the on-screen summary shows it too", /70/.test(liveTotal), liveTotal);
    check("Phone A stayed signed in across the reload", !(await A.page.isVisible("#auth-screen")));
  }

  /* ---------------- 4. closing the day is shared ---------------- */
  group("4. Closing the day, seen from both devices");
  {
    await A.page.click('.nav-item[data-nav="sales"]');
    await A.page.waitForTimeout(300);
    await A.page.click("#close-day-btn");
    await A.page.waitForTimeout(400);
    await A.page.click("#confirm-close-day-btn");
    await A.page.waitForTimeout(900);
    await A.page.click("#modal-final .btn, #modal-final .modal-close").catch(() => {});
    check("Phone A closed the day", (await apiIn(A.page, "/days")).days[0].status === "closed");

    await B.page.reload({ waitUntil: "networkidle" });
    await B.page.waitForTimeout(900);
    check("Phone B sees the day closed", (await apiIn(B.page, "/days")).days[0].status === "closed");
    check("Phone B is blocked from selling into it",
      await B.page.evaluate(() => getComputedStyle(document.getElementById("sales-guard")).display) !== "none");
    check("the closed day's sales are still visible on Phone B",
      (await B.page.$$("#sales-tbody tr")).length === 2);
    check("the closed day's notes survived", (await apiIn(B.page, "/notes")).notes.length === 1);
    check("the report is available on Phone B",
      (await apiIn(B.page, "/days?status=closed")).reports.length === 1);
    await B.page.click('.nav-item[data-nav="reports"]');
    await B.page.waitForTimeout(400);
    check("the report card is rendered on Phone B", (await B.page.$$(".report-card")).length === 1);
  }

  /* ---------------- 5. language + sign out ---------------- */
  group("5. Language follows the account; sign out works");
  {
    await B.page.click("#lang-toggle");
    await B.page.waitForTimeout(600);
    check("Phone B switched to English", await B.page.evaluate(() => document.documentElement.dir) === "ltr");
    await A.page.reload({ waitUntil: "networkidle" });
    await A.page.waitForTimeout(900);
    check("Phone A picks up the language from the server",
      await A.page.evaluate(() => document.documentElement.dir) === "ltr");
    await A.page.click("#lang-toggle");
    await A.page.waitForTimeout(600);
    check("back to Arabic + RTL", await A.page.evaluate(() => document.documentElement.dir) === "rtl");

    await B.page.click('.nav-item[data-nav="settings"]');
    await B.page.waitForTimeout(300);
    check("the account name is shown in settings",
      (await B.page.textContent("#account-username")).includes(CREDS.username));
    await B.page.click("#logout-btn");
    await B.page.waitForTimeout(300);
    await B.page.click("#confirm-ok-btn");
    await B.page.waitForTimeout(800);
    check("sign out returns to the sign-in screen", await B.page.isVisible("#auth-screen"));
    await B.page.reload({ waitUntil: "networkidle" });
    await B.page.waitForTimeout(800);
    check("still signed out after reload", await B.page.isVisible("#auth-screen"));
    check("Phone A is unaffected by Phone B signing out", !(await A.page.isVisible("#auth-screen")));
  }

  /* ---------------- 6. nothing is kept in browser storage ---------------- */
  group("6. No ledger data left in the browser");
  {
    const keys = await A.page.evaluate(() => Object.keys(localStorage));
    check("localStorage holds only the token and the ui cache",
      keys.every(k => k === "bm_token" || k === "bm_ui"), keys);
    check("no sales/notes/day data on the device",
      !keys.some(k => /sales|notes|sessions|reports|productNames/i.test(k)), keys);
  }

  await A.page.screenshot({ path: "/home/user/screens/e2e-phone-a.png", fullPage: true });
  await B.page.screenshot({ path: "/home/user/screens/e2e-phone-b-login.png" });
  await browser.close();

  console.log(errors.length ? "\nBROWSER ERRORS:\n" + errors.join("\n") : "\nNo console/page errors \u2713");
  console.log("\n========================================");
  console.log("  PASSED: " + pass + "   FAILED: " + fail + (errors.length ? "   (see browser errors)" : ""));
  console.log("========================================\n");
  process.exit(fail || errors.length ? 1 : 0);
})().catch(err => { console.error("suite crashed:", err); process.exit(1); });
