"use strict";
/* /api/settings, /api/bootstrap, /api/import, /api/data
   Everything the app needs in one round trip, plus the one-time
   import of data left in a browser by the pre-backend version.      */
const express = require("express");
const db = require("../db");
const { wrap, HttpError, cleanText, isoDate, dayNameFor } = require("../lib/http");
const { mapSale, mapDay, mapNote, mapTotals, mapReport, TOTALS_SELECT } = require("../lib/map");
const { normalizeName } = require("../lib/names");

const router = express.Router();

/* ---------------- settings (follow the account across devices) ---------------- */
async function readSettings(userId) {
  const { rows } = await db.query("SELECT lang, theme FROM settings WHERE user_id = $1", [userId]);
  return rows[0] || { lang: "ar", theme: "dark" };
}

router.get("/settings", wrap(async (req, res) => {
  res.json({ settings: await readSettings(req.user.id) });
}));

router.put("/settings", wrap(async (req, res) => {
  const lang = req.body.lang === "en" ? "en" : "ar";           // Arabic is the default
  const theme = req.body.theme === "light" ? "light" : "dark";
  const { rows } = await db.query(
    `INSERT INTO settings (user_id, lang, theme, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (user_id) DO UPDATE SET lang = $2, theme = $3, updated_at = now()
     RETURNING lang, theme`, [req.user.id, lang, theme]);
  res.json({ settings: rows[0] });
}));

/* ---------------- bootstrap: one request, whole ledger ---------------- */
router.get("/bootstrap", wrap(async (req, res) => {
  const [settings, days, sales, notes, names] = await Promise.all([
    readSettings(req.user.id),
    db.query(`SELECT d.*, ${TOTALS_SELECT} FROM days d LEFT JOIN sales s ON s.day_id = d.id
              GROUP BY d.id ORDER BY d.day_date DESC`),
    db.query("SELECT * FROM sales ORDER BY sale_time DESC, id DESC LIMIT 2000"),
    db.query("SELECT * FROM notes ORDER BY note_time DESC, id DESC LIMIT 2000"),
    db.query("SELECT name FROM product_names ORDER BY usage_count DESC, last_used_at DESC LIMIT 2000")
  ]);
  res.json({
    user: { id: String(req.user.id), username: req.user.username, email: req.user.email },
    settings,
    sessions: days.rows.map(mapDay),
    reports: days.rows.filter(r => r.status === "closed").map(mapReport),
    sales: sales.rows.map(mapSale),
    notes: notes.rows.map(mapNote),
    productNames: names.rows.map(r => r.name),
    serverTime: new Date().toISOString()
  });
}));

/* ---------------- one-time import of pre-backend browser data ----------------
   Only allowed while the ledger is still empty, so it can never
   duplicate or overwrite anything already on the server.            */
router.post("/import", wrap(async (req, res) => {
  const existing = await db.query("SELECT (SELECT count(*) FROM sales) s, (SELECT count(*) FROM days) d");
  if (Number(existing.rows[0].s) > 0 || Number(existing.rows[0].d) > 0) {
    throw new HttpError(409, "ledger_not_empty", "The server already holds ledger data");
  }
  const sessions = Array.isArray(req.body.sessions) ? req.body.sessions : [];
  const sales = Array.isArray(req.body.sales) ? req.body.sales : [];
  const notes = Array.isArray(req.body.notes) ? req.body.notes : [];
  const names = Array.isArray(req.body.productNames) ? req.body.productNames : [];

  const counts = await db.tx(async client => {
    const dayIdByOld = new Map();
    let openSeen = false;

    for (const s of sessions) {
      const date = isoDate(s.date);
      const status = s.status === "open" && !openSeen ? "open" : "closed";
      if (status === "open") openSeen = true;
      const closedAt = status === "closed" ? (s.closedAt || new Date().toISOString()) : null;
      const { rows } = await client.query(
        `INSERT INTO days (day_date, day_name, status, opened_at, closed_at)
         VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()), $5)
         ON CONFLICT (day_date) DO UPDATE SET day_name = EXCLUDED.day_name
         RETURNING id`,
        [date, cleanText(s.dayName || dayNameFor(date), { field: "dayName", max: 40 }), status, s.startedAt || null, closedAt]);
      dayIdByOld.set(String(s.id), rows[0].id);
    }

    for (const n of names) {
      const name = String(n || "").replace(/\s+/g, " ").trim();
      const norm = normalizeName(name);
      if (!norm) continue;
      await client.query(
        `INSERT INTO product_names (name, normalized_name) VALUES ($1,$2)
         ON CONFLICT (normalized_name) DO NOTHING`, [name, norm]);
    }

    let saleCount = 0;
    /* oldest first so invoice numbers keep their original order */
    for (const s of [...sales].reverse()) {
      const dayId = dayIdByOld.get(String(s.sessionId));
      if (!dayId) continue;
      const qty = Math.max(1, parseInt(s.qty, 10) || 1);
      const price = Math.max(0, Number(s.price) || 0);
      const wholesale = Math.max(0, Number(s.wholesale) || 0);
      const payment = s.payment === "card" ? "card" : "cash";
      await client.query(
        `INSERT INTO sales (day_id, invoice_no, product_name, quantity, wholesale_price,
                            selling_price, payment_method, sale_date, sale_time, created_at)
         VALUES ($1, COALESCE($2, 'INV-' || lpad(nextval('invoice_seq')::text, 5, '0')),
                 $3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()), COALESCE($9::timestamptz, now()))
         ON CONFLICT (invoice_no) DO NOTHING`,
        [dayId, s.invoice || null, cleanText(s.product, { field: "product", max: 80 }),
         qty, wholesale, price, payment, isoDate(s.date), s.time || null]);
      const norm = normalizeName(s.product);
      if (norm) {
        await client.query(
          `INSERT INTO product_names (name, normalized_name, usage_count) VALUES ($1,$2,1)
           ON CONFLICT (normalized_name) DO UPDATE SET usage_count = product_names.usage_count + 1`,
          [String(s.product).replace(/\s+/g, " ").trim(), norm]);
      }
      saleCount++;
    }

    let noteCount = 0;
    for (const n of [...notes].reverse()) {
      const dayId = dayIdByOld.get(String(n.sessionId));
      const text = String(n.text || "").replace(/\s+/g, " ").trim();
      if (!dayId || !text) continue;
      await client.query(
        `INSERT INTO notes (day_id, note_text, note_date, note_time, created_at)
         VALUES ($1,$2,$3, COALESCE($4::timestamptz, now()), COALESCE($4::timestamptz, now()))`,
        [dayId, text, isoDate(n.date), n.time || null]);
      noteCount++;
    }

    /* keep the invoice sequence ahead of anything imported */
    await client.query(
      `SELECT setval('invoice_seq', GREATEST(
         (SELECT COALESCE(MAX(NULLIF(regexp_replace(invoice_no, '\\D', '', 'g'), '')::bigint), 0) FROM sales), 1))`);

    return { days: dayIdByOld.size, sales: saleCount, notes: noteCount, productNames: names.length };
  });

  res.status(201).json({ imported: counts });
}));

/* ---------------- danger zone: wipe the ledger, keep the account ---------------- */
router.delete("/data", wrap(async (req, res) => {
  if (String(req.body && req.body.confirm) !== "DELETE") {
    throw new HttpError(400, "confirm_required", 'Send { "confirm": "DELETE" }');
  }
  await db.tx(async client => {
    await client.query("DELETE FROM notes");
    await client.query("DELETE FROM sales");
    await client.query("DELETE FROM days");
    await client.query("DELETE FROM product_names");
    await client.query("SELECT setval('invoice_seq', 1, false)");
  });
  res.json({ ok: true });
}));

module.exports = router;
