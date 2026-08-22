"use strict";
/* /api/days — one open day at a time; closing is permanent and shared. */
const express = require("express");
const db = require("../db");
const { wrap, HttpError, isoDate, cleanText, dayNameFor } = require("../lib/http");
const { mapDay, mapNote, mapSale, mapTotals, mapReport, TOTALS_SELECT } = require("../lib/map");

const router = express.Router();

const DAY_WITH_TOTALS = `
  SELECT d.*, ${TOTALS_SELECT}
    FROM days d
    LEFT JOIN sales s ON s.day_id = d.id`;

async function dayById(id) {
  const { rows } = await db.query("SELECT * FROM days WHERE id = $1", [id]);
  if (!rows.length) throw new HttpError(404, "day_not_found", "Day not found");
  return rows[0];
}

/* every day + its summary (Reports screen reads this) */
router.get("/", wrap(async (req, res) => {
  const status = req.query.status;
  const params = [];
  let where = "";
  if (status === "open" || status === "closed") { params.push(status); where = "WHERE d.status = $1"; }
  const { rows } = await db.query(`${DAY_WITH_TOTALS} ${where} GROUP BY d.id ORDER BY d.day_date DESC`, params);
  res.json({
    days: rows.map(r => Object.assign(mapDay(r), { totals: mapTotals(r) })),
    reports: rows.filter(r => r.status === "closed").map(mapReport)
  });
}));

/* the currently open day, if any */
router.get("/current", wrap(async (_req, res) => {
  const { rows } = await db.query(`${DAY_WITH_TOTALS} WHERE d.status = 'open' GROUP BY d.id LIMIT 1`);
  if (!rows.length) return res.json({ day: null, totals: null });
  res.json({ day: mapDay(rows[0]), totals: mapTotals(rows[0]) });
}));

/* open a new day (idempotent-ish: refuses when one is already open) */
router.post("/", wrap(async (req, res) => {
  const date = req.body.date ? isoDate(req.body.date) : new Date().toISOString().slice(0, 10);
  const dayName = req.body.dayName ? cleanText(req.body.dayName, { field: "dayName", max: 40 }) : dayNameFor(date);

  const open = await db.query("SELECT id FROM days WHERE status = 'open'");
  if (open.rows.length) throw new HttpError(409, "day_already_open", "A day is already open");

  const existing = await db.query("SELECT id, status FROM days WHERE day_date = $1", [date]);
  if (existing.rows.length) {
    /* re-opening a previously closed date would rewrite history — refuse */
    throw new HttpError(409, "day_exists", "That date already has a ledger day");
  }
  const { rows } = await db.query(
    `INSERT INTO days (day_date, day_name) VALUES ($1,$2) RETURNING *`, [date, dayName]);
  res.status(201).json({ day: mapDay(rows[0]) });
}));

/* day detail: sales + notes + totals (works for open and closed days) */
router.get("/:id", wrap(async (req, res) => {
  const day = await dayById(req.params.id);
  const [totals, sales, notes] = await Promise.all([
    db.query(`${DAY_WITH_TOTALS} WHERE d.id = $1 GROUP BY d.id`, [day.id]),
    db.query("SELECT * FROM sales WHERE day_id = $1 ORDER BY sale_time DESC, id DESC", [day.id]),
    db.query("SELECT * FROM notes WHERE day_id = $1 ORDER BY note_time DESC, id DESC", [day.id])
  ]);
  res.json({
    day: mapDay(day),
    totals: mapTotals(totals.rows[0]),
    sales: sales.rows.map(mapSale),
    notes: notes.rows.map(mapNote)
  });
}));

/* close the day — persisted, so every other device sees it locked */
router.post("/:id/close", wrap(async (req, res) => {
  const day = await dayById(req.params.id);
  if (day.status === "closed") throw new HttpError(409, "day_already_closed", "Day is already closed");

  const { rows } = await db.query(
    `UPDATE days SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open' RETURNING *`, [day.id]);
  if (!rows.length) throw new HttpError(409, "day_already_closed", "Day is already closed");

  const totals = await db.query(`${DAY_WITH_TOTALS} WHERE d.id = $1 GROUP BY d.id`, [day.id]);
  const notes = await db.query("SELECT count(*)::int AS n FROM notes WHERE day_id = $1", [day.id]);
  res.json({
    day: mapDay(rows[0]),
    totals: mapTotals(totals.rows[0]),
    noteCount: notes.rows[0].n,
    report: mapReport(totals.rows[0])
  });
}));

module.exports = router;
