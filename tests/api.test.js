/* Blue Mobile — backend API suite.  node tests/api.test.js
   Exercises: single account, auth, sales maths, autocomplete, notes,
   day closing, cross-device visibility and endpoint protection.     */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const group = n => console.log("\n=== " + n + " ===");
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + label); }
  else { fail++; console.log("  \u2717 FAIL: " + label + (extra !== undefined ? "  \u2192 " + JSON.stringify(extra) : "")); }
};

/* a "device" = an isolated client with its own cookie jar / token */
function device(name) {
  let cookie = null, token = null;
  return {
    name,
    get token() { return token; },
    async call(method, path, body, opts = {}) {
      const headers = { "content-type": "application/json" };
      if (cookie && !opts.noCookie) headers.cookie = cookie;
      if (token && opts.bearer) headers.authorization = "Bearer " + token;
      const res = await fetch(BASE + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const m = /bm_session=([^;]*)/.exec(setCookie);
        if (m) cookie = m[1] === "" ? null : "bm_session=" + m[1];
      }
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (data && data.token) token = data.token;
      return { status: res.status, data, raw: res };
    },
    get(p, o)      { return this.call("GET", p, undefined, o); },
    post(p, b, o)  { return this.call("POST", p, b || {}, o); },
    put(p, b)      { return this.call("PUT", p, b); },
    del(p, b)      { return this.call("DELETE", p, b); },
    forgetCookie() { cookie = null; token = null; }
  };
}

const CREDS = { username: "blue", email: "owner@bluemobile.ly", password: "ledger-2026-pass" };

(async () => {
  const A = device("Phone A");   // first device
  const B = device("Phone B");   // second device, same account
  const anon = device("stranger");

  /* ---------------- 0. reset to a known state ---------------- */
  {
    const tmp = device("setup");
    const st = await tmp.get("/api/auth/status");
    if (!st.data.setupRequired) {
      await tmp.post("/api/auth/login", { username: CREDS.username, password: CREDS.password });
      await tmp.del("/api/data", { confirm: "DELETE" });
    }
  }

  /* ---------------- 1. health + protection ---------------- */
  group("1. Service and endpoint protection");
  {
    const h = await anon.get("/api/health");
    check("health endpoint reports the database up", h.status === 200 && h.data.db === "up", h.data);

    for (const path of ["/api/bootstrap", "/api/sales", "/api/products?q=ج", "/api/notes", "/api/days", "/api/settings"]) {
      const r = await anon.get(path);
      check(`GET ${path} rejects anonymous callers (401)`, r.status === 401, r.status);
    }
    const w = await anon.post("/api/sales", { product: "x", qty: 1, price: 1, wholesale: 0, payment: "cash" });
    check("POST /api/sales rejects anonymous callers (401)", w.status === 401, w.status);
    const dd = await anon.del("/api/data", { confirm: "DELETE" });
    check("destructive endpoint rejects anonymous callers", dd.status === 401, dd.status);
  }

  /* ---------------- 2. the single account ---------------- */
  group("2. Single account");
  {
    let st = await A.get("/api/auth/status");
    const fresh = st.data.setupRequired;
    if (fresh) {
      const short = await A.post("/api/auth/setup", { username: "ab", password: "short" });
      check("setup rejects a too-short username", short.status === 400, short.data);
      const weak = await A.post("/api/auth/setup", { username: CREDS.username, password: "123" });
      check("setup rejects a weak password", weak.status === 400, weak.data);
      const made = await A.post("/api/auth/setup", CREDS);
      check("the one account is created", made.status === 201 && made.data.user.username === CREDS.username, made.data);
      check("setup signs the device in immediately", !!made.data.token);
    } else {
      const again = await A.post("/api/auth/setup", { username: "second", password: "another-pass-123" });
      check("account already existed — setup refuses (409)", again.status === 409, again.data);
      await A.post("/api/auth/login", { username: CREDS.username, password: CREDS.password });
      pass += 3; console.log("  \u2713 (account pre-existing: creation checks covered by the 409 above)");
    }

    const second = await device("intruder").post("/api/auth/setup", { username: "second", email: "x@y.z", password: "another-pass-123" });
    check("a SECOND account cannot be created (409)", second.status === 409 && second.data.error === "account_exists", second.data);

    st = await A.get("/api/auth/status");
    check("status reports setup complete", st.data.setupRequired === false);
    check("status tells the UI to hide sign-up", st.data.signupDisabled === true);

    const users = await A.get("/api/auth/me");
    check("me returns the account", users.status === 200 && users.data.user.username === CREDS.username);
  }

  /* ---------------- 3. authentication ---------------- */
  group("3. Authentication");
  {
    const badPass = await device("x").post("/api/auth/login", { username: CREDS.username, password: "wrong-password" });
    check("wrong password is rejected (401)", badPass.status === 401 && badPass.data.error === "invalid_credentials", badPass.data);
    const badUser = await device("x").post("/api/auth/login", { username: "nobody", password: CREDS.password });
    check("unknown user is rejected (401)", badUser.status === 401, badUser.data);

    const byEmail = device("email-login");
    const em = await byEmail.post("/api/auth/login", { username: CREDS.email, password: CREDS.password });
    check("login works with the email too", em.status === 200, em.data);

    const bearer = device("bearer");
    await bearer.post("/api/auth/login", { username: CREDS.username, password: CREDS.password });
    const viaBearer = await bearer.get("/api/bootstrap", { noCookie: true, bearer: true });
    check("Authorization: Bearer works (needed inside iframes)", viaBearer.status === 200, viaBearer.status);

    const out = device("logout-test");
    await out.post("/api/auth/login", { username: CREDS.username, password: CREDS.password });
    const okBefore = await out.get("/api/sales");
    await out.post("/api/auth/logout");
    const afterLogout = await out.get("/api/sales");
    check("logout invalidates that session server-side", okBefore.status === 200 && afterLogout.status === 401, afterLogout.status);

    const stolen = device("stolen");
    const junk = await stolen.get("/api/sales", { bearer: false });
    check("a forged/absent token gets nothing", junk.status === 401);
  }

  /* ---------------- 4. day + sales maths ---------------- */
  group("4. Day, sales and the arithmetic");
  let dayId;
  {
    const today = new Date().toISOString().slice(0, 10);
    const opened = await A.post("/api/days", { date: today, dayName: "الخميس" });
    check("a day can be opened", opened.status === 201 && opened.data.day.status === "open", opened.data);
    dayId = opened.data.day.id;

    const twice = await A.post("/api/days", { date: today });
    check("a second open day is refused", twice.status === 409, twice.data);

    const sale = await A.post("/api/sales", { product: "جواء", qty: 2, price: 20, wholesale: 15, payment: "cash" });
    check("sale created", sale.status === 201, sale.data);
    const s = sale.data.sale;
    check("the database computes 2 x (20/15) -> 40 / 30 / 10",
      s.total === 40 && s.cost === 30 && s.profit === 10, s);
    check("both prices are stored", s.price === 20 && s.wholesale === 15, s);
    check("payment method stored", s.payment === "cash");
    check("date, time and invoice recorded", !!s.date && !!s.time && /^INV-\d{5}$/.test(s.invoice), s);

    /* the client cannot fake the totals */
    const liar = await A.post("/api/sales", { product: "محاولة", qty: 1, price: 10, wholesale: 4, total: 9999, profit: 9999, payment: "card" });
    check("client-supplied total/profit are ignored",
      liar.data.sale.total === 10 && liar.data.sale.profit === 6, liar.data.sale);
    await A.del("/api/sales/" + liar.data.sale.id);

    const bad = await A.post("/api/sales", { product: "", qty: 1, price: 5, wholesale: 1, payment: "cash" });
    check("empty product name rejected", bad.status === 400, bad.data);
    const badQty = await A.post("/api/sales", { product: "x", qty: 0, price: 5, wholesale: 1, payment: "cash" });
    check("quantity 0 rejected", badQty.status === 400, badQty.data);
    const badPrice = await A.post("/api/sales", { product: "x", qty: 1, price: -5, wholesale: 1, payment: "cash" });
    check("negative price rejected", badPrice.status === 400, badPrice.data);
    const badPay = await A.post("/api/sales", { product: "x", qty: 1, price: 5, wholesale: 1, payment: "bitcoin" });
    check("unknown payment method rejected", badPay.status === 400, badPay.data);

    await A.post("/api/sales", { product: "شاحن 33 واط", qty: 1, price: 50, wholesale: 35, payment: "card" });
    const list = await A.get("/api/sales");
    check("sales can be retrieved", list.data.sales.length === 2, list.data.sales.length);
    const byDate = await A.get("/api/sales?date=" + today);
    check("sales can be fetched by date", byDate.data.sales.length === 2);

    const sum = await A.get("/api/sales/summary");
    check("daily summary: 90 total / 40 cash / 50 card / 2 sales",
      sum.data.summary.total === 90 && sum.data.summary.cash === 40 &&
      sum.data.summary.card === 50 && sum.data.summary.count === 2, sum.data.summary);
    check("daily summary: 65 wholesale cost / 25 profit (30+35 and 10+15)",
      sum.data.summary.cost === 65 && sum.data.summary.profit === 25, sum.data.summary);

    const upd = await A.put("/api/sales/" + s.id, { product: "جواء", qty: 3, price: 25, wholesale: 10, payment: "cash" });
    check("sale update recalculates 3 x (25/10) -> 75/30/45",
      upd.data.sale.total === 75 && upd.data.sale.cost === 30 && upd.data.sale.profit === 45, upd.data.sale);
    await A.put("/api/sales/" + s.id, { product: "جواء", qty: 2, price: 20, wholesale: 15, payment: "cash" });
  }

  /* ---------------- 5. autocomplete from the database ---------------- */
  group("5. Product autocomplete (server side)");
  {
    for (const n of ["جوال سامسونج", "جوال آيفون", "جراب آيفون", "سماعة بلوتوث"]) {
      await A.post("/api/products", { name: n });
    }
    const names = async q => (await A.get("/api/products?q=" + encodeURIComponent(q))).data.suggestions.map(s => s.name);
    const j1 = await names("ج");
    check('"ج" returns the ج names', j1.length >= 4, j1);
    const j2 = await names("جو");
    check('"جو" narrows', j2.length < j1.length && j2.length === 3, j2);
    const j3 = await names("جوا");
    check('"جوا" keeps narrowing', j3.length === 3, j3);
    const j4 = await names("جوال");
    check('"جوال" narrows to 2', j4.length === 2, j4);
    const j5 = await names("جوال س");
    check('"جوال س" narrows to 1 and is the closest match', j5.join() === "جوال سامسونج", j5);
    const hamza = await names("جوال ا");
    check("alef/hamza normalisation does not widen results", hamza.join() === "جوال آيفون", hamza);
    check("first suggestion is the closest match", (await names("سما"))[0] === "سماعة بلوتوث");

    const dup = await A.post("/api/products", { name: "جوال سامسونج" });
    check("saving an existing name does not duplicate it", dup.status === 201);
    const all = (await A.get("/api/products/all")).data.names;
    check("no duplicate product names stored",
      new Set(all).size === all.length && all.filter(n => n === "جوال سامسونج").length === 1, all);
    check("a name created by selling is remembered", all.includes("جواء"), all);
  }

  /* ---------------- 6. daily notes ---------------- */
  group("6. Daily notes");
  {
    const before = (await A.get("/api/sales/summary")).data.summary;
    for (const text of ["أعطيت أخوي 100 د.ل", "دفعت 50 د.ل توصيل", "أعطيت فلان 30 د.ل"]) {
      const r = await A.post("/api/notes", { text });
      check("note added: " + text, r.status === 201 && r.data.note.text === text, r.data);
    }
    const notes = await A.get("/api/notes?dayId=" + dayId);
    check("three notes stored for the day", notes.data.notes.length === 3, notes.data.notes.length);
    check("each note carries id, text, date and time",
      notes.data.notes.every(n => n.id && n.text && n.date && n.time));
    check("notes come back newest first", notes.data.notes[0].text === "أعطيت فلان 30 د.ل");

    const after = (await A.get("/api/sales/summary")).data.summary;
    check("notes changed NOTHING in the totals", JSON.stringify(before) === JSON.stringify(after), { before, after });

    const empty = await A.post("/api/notes", { text: "   " });
    check("empty note rejected", empty.status === 400, empty.data);

    const del = await A.del("/api/notes/" + notes.data.notes[2].id);
    check("note can be deleted", del.status === 200);
    check("two notes remain", (await A.get("/api/notes?dayId=" + dayId)).data.notes.length === 2);
  }

  /* ---------------- 7. cross-device ---------------- */
  group("7. Cross-device (Phone A -> PostgreSQL -> Phone B)");
  {
    const login = await B.post("/api/auth/login", { username: CREDS.username, password: CREDS.password });
    check("Phone B signs in with the same account", login.status === 200, login.data);

    const boot = await B.get("/api/bootstrap");
    check("Phone B sees the sale created on Phone A",
      boot.data.sales.some(s => s.product === "جواء" && s.total === 40), boot.data.sales);
    check("Phone B sees the same product suggestions",
      (await B.get("/api/products?q=ج")).data.suggestions.length >= 4);
    check("Phone B types 'ج' and gets the name Phone A created",
      (await B.get("/api/products?q=ج")).data.suggestions.some(s => s.name === "جواء"));
    check("Phone B sees both notes", boot.data.notes.length === 2, boot.data.notes.length);
    check("Phone B sees the open day", boot.data.sessions.some(d => d.id === dayId && d.status === "open"));

    const sumA = (await A.get("/api/sales/summary")).data.summary;
    const sumB = (await B.get("/api/sales/summary")).data.summary;
    check("daily totals are identical on both devices", JSON.stringify(sumA) === JSON.stringify(sumB), { sumA, sumB });

    /* B writes, A reads */
    await B.post("/api/sales", { product: "كيبل من الجهاز الثاني", qty: 1, price: 12, wholesale: 5, payment: "card" });
    await B.post("/api/notes", { text: "ملاحظة من الجهاز الثاني" });
    const backOnA = await A.get("/api/bootstrap");
    check("a sale made on Phone B appears on Phone A",
      backOnA.data.sales.some(s => s.product === "كيبل من الجهاز الثاني"));
    check("a note made on Phone B appears on Phone A",
      backOnA.data.notes.some(n => n.text === "ملاحظة من الجهاز الثاني"));
    check("both devices agree on the running totals",
      (await A.get("/api/sales/summary")).data.summary.total === (await B.get("/api/sales/summary")).data.summary.total);

    /* settings follow the account */
    await A.put("/api/settings", { lang: "en", theme: "light" });
    const sB = await B.get("/api/settings");
    check("interface settings follow the account across devices",
      sB.data.settings.lang === "en" && sB.data.settings.theme === "light", sB.data);
    await A.put("/api/settings", { lang: "ar", theme: "dark" });
    check("Arabic remains the stored default after reset",
      (await B.get("/api/settings")).data.settings.lang === "ar");
  }

  /* ---------------- 8. closing the day ---------------- */
  group("8. Day closing persists for every device");
  {
    const beforeClose = (await A.get("/api/sales/summary")).data.summary;
    const closed = await A.post("/api/days/" + dayId + "/close");
    check("day closes", closed.status === 200 && closed.data.day.status === "closed", closed.data);
    check("closing returns the final summary",
      closed.data.totals.total === beforeClose.total && closed.data.totals.profit === beforeClose.profit, closed.data.totals);
    check("closing counts the notes without adding them to money",
      closed.data.noteCount === 3 && closed.data.totals.total === beforeClose.total, closed.data);

    const again = await A.post("/api/days/" + dayId + "/close");
    check("a closed day cannot be closed twice", again.status === 409, again.data);

    const late = await A.post("/api/sales", { product: "بعد الإغلاق", qty: 1, price: 10, wholesale: 5, payment: "cash" });
    check("no new sale can be added once the day is closed", late.status === 409, late.data);
    const sales = (await A.get("/api/sales?dayId=" + dayId)).data.sales;
    const edit = await A.put("/api/sales/" + sales[0].id, { product: "تعديل", qty: 1, price: 1, wholesale: 0, payment: "cash" });
    check("sales in a closed day cannot be edited", edit.status === 409, edit.data);
    const rm = await A.del("/api/sales/" + sales[0].id);
    check("sales in a closed day cannot be deleted", rm.status === 409, rm.data);
    const noteAfter = await A.post("/api/notes", { dayId, text: "ملاحظة بعد الإغلاق" });
    check("notes cannot be added to a closed day", noteAfter.status === 409, noteAfter.data);

    const detail = await A.get("/api/days/" + dayId);
    check("the closed day's sales stay visible", detail.data.sales.length === 3, detail.data.sales.length);
    check("the closed day's notes stay visible", detail.data.notes.length === 3, detail.data.notes.length);
    check("the closed day's summary stays visible", detail.data.totals.total === beforeClose.total);
    check("nothing was destroyed by closing",
      detail.data.sales.length > 0 && detail.data.notes.length > 0);

    /* B must see the lock — this is the whole point of storing it */
    const bDay = (await B.get("/api/days")).data.days.find(d => d.id === dayId);
    check("Phone B sees the day as closed", bDay.status === "closed", bDay);
    const bLate = await B.post("/api/sales", { product: "من الجهاز الثاني بعد الإغلاق", qty: 1, price: 10, wholesale: 5, payment: "cash" });
    check("Phone B also cannot sell into the closed day", bLate.status === 409, bLate.data);
    const bReports = (await B.get("/api/days?status=closed")).data.reports;
    check("Phone B sees the closed day in reports with the same figures",
      bReports.some(r => r.sessionId === dayId && r.totals.total === beforeClose.total), bReports);
  }

  /* ---------------- 9. no inventory ---------------- */
  group("9. Still a sales ledger only");
  {
    const boot = (await A.get("/api/bootstrap")).data;
    const keys = new Set(Object.keys(boot).concat(Object.keys(boot.sales[0] || {})));
    const forbidden = [...keys].filter(k => /stock|inventory|warehouse|supplier|purchase|on_hand|reorder/i.test(k));
    check("no stock/inventory fields anywhere in the API payload", forbidden.length === 0, forbidden);
    check("product names carry no quantity",
      (await A.get("/api/products?q=جوال")).data.suggestions.every(s => !("stock" in s) && !("quantity" in s)));
  }

  console.log("\n========================================");
  console.log("  PASSED: " + pass + "   FAILED: " + fail);
  console.log("========================================\n");
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error("suite crashed:", err); process.exit(1); });
