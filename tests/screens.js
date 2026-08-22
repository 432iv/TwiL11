/* Screenshot pass against the live server.
   NODE_PATH=/tmp/bmtest/node_modules node tests/screens.js            */
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const OUT = "/home/user/screens/";
const CREDS = { username: "blue", password: "ledger-2026-pass" };

(async () => {
  const status = await (await fetch(BASE + "/api/auth/status")).json();
  if (status.setupRequired) {
    await fetch(BASE + "/api/auth/setup", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: CREDS.username, password: CREDS.password }) });
  }
  const b = await chromium.launch();
  const errs = [];
  const shot = async (name, w, h, fn) => {
    const c = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    const p = await c.newPage();
    p.on("pageerror", e => errs.push(name + ": " + e.message));
    await p.goto(BASE + "/", { waitUntil: "networkidle" });
    await p.waitForTimeout(500);
    await fn(p);
    await p.screenshot({ path: OUT + name + ".png", fullPage: w > 500 });
    await c.close();
  };
  const signIn = async p => {
    await p.fill("#login-username", CREDS.username);
    await p.fill("#login-password", CREDS.password);
    await p.click("#auth-login-form button[type=submit]");
    await p.waitForTimeout(1200);
  };

  await shot("10-signin-ar", 1280, 800, async () => {});
  await shot("11-signin-mobile-ar", 390, 780, async () => {});
  await shot("12-dashboard-ar", 1280, 900, signIn);
  await shot("13-sales-ar", 1280, 1400, async p => {
    await signIn(p);
    await p.click('.nav-item[data-nav="sales"]');
    await p.waitForTimeout(400);
  });
  await shot("14-reports-ar", 1280, 900, async p => {
    await signIn(p);
    await p.click('.nav-item[data-nav="reports"]');
    await p.waitForTimeout(400);
  });
  await shot("15-settings-ar", 1280, 900, async p => {
    await signIn(p);
    await p.click('.nav-item[data-nav="settings"]');
    await p.waitForTimeout(400);
  });
  await shot("16-sales-mobile-ar", 390, 900, async p => {
    await signIn(p);
    await p.click('.nav-item[data-nav="sales"]');
    await p.waitForTimeout(400);
  });

  await b.close();
  console.log(errs.length ? "ERRORS:\n" + errs.join("\n") : "No page errors \u2713");
})();
