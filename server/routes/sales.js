"use strict";
const express = require("express");
const db = require("../db");
const { wrap, HttpError, cleanText, toInt, toMoney, isoDate } = require("../lib/http");
const { mapSale, mapTotals, TOTALS_SELECT } = require("../lib/map");
const { rememberName } = require("./products");

const router = express.Router();

async function getDay(dayId) {
  const { rows } = await db.query("SELECT id, status, day_date FROM days WHERE id = $1", [dayId]);
  if (!rows.length) throw new HttpError(404, "day_not_found", "Day not found");
  return rows[0];
}

async function validPayment(code) {
  const { rows } = await db.query("SELECT code FROM payment_methods WHERE code = $1 AND active", [code]);
  if (!rows.length) throw new HttpError(400, "payment_invalid", "Unknown payment method");
  return rows[0].code;
}

router.get("/", wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.date)  { params.push(isoDate(req.query.date)); where.push(`sale_date = $${params.length}`); }
  if (req.query.dayId) { params.push(req.query.dayId);          where.push(`day_id = $${params.length}`); }
  if (req.query.q) {
    params.push("%" + String(req.query.q).trim().toLowerCase() + "%");
    where.push(`(lower(product_name) LIKE $${params.length} OR lower(invoice_no) LIKE $${params.length})`);
  }
  const limit = Math.min(parseInt(req.query.limit || "1000", 10) || 1000, 5000);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT * FROM sales ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY sale_time DESC, id DESC LIMIT $${params.length}`, params);
  res.json({ sales: rows.map(mapSale) });
}));

router.get("/summary", wrap(async (req, res) => {
  let sql = `SELECT d.*, ${TOTALS_SELECT} FROM days d LEFT JOIN sales s ON s.day_id = d.id`;
  const params = [];
  if (req.query.dayId)      { params.push(req.query.dayId);          sql += ` WHERE d.id = $1`; }
  else if (req.query.date)  { params.push(isoDate(req.query.date));  sql += ` WHERE d.day_date = $1`; }
  else                      { sql += ` WHERE d.status = 'open'`; }
  const { rows } = await db.query(sql + " GROUP BY d.id LIMIT 1", params);
  if (!rows.length) return res.json({ summary: null });
  res.json({
    summary: mapTotals(rows[0]),
    day: { id: String(rows[0].id), date: rows[0].day_date, status: rows[0].status }
  });
}));

router.post("/", wrap(async (req, res) => {
  let day;
  if (req.body.dayId) {
    day = await getDay(req.body.dayId);
  } else {
    const open = await db.query("SELECT * FROM days WHERE status = 'open'");
    if (!open.rows.length) throw new HttpError(409, "no_open_day", "Start a day first");
    day = open.rows[0];
  }

  const product   = cleanText(req.body.product ?? req.body.product_name, { field: "product", max: 80 });
  const qty       = toInt(req.body.qty ?? req.body.quantity, { field: "qty" });
  const price     = toMoney(req.body.price ?? req.body.selling_price, { field: "price" });
  const wholesale = toMoney(req.body.wholesale ?? req.body.wholesale_price ?? 0, { field: "wholesale" });
  const payment   = await validPayment(req.body.payment ?? req.body.payment_method);

  const sale = await db.tx(async client => {
    const canonical = await rememberName(client, product);
    const { rows } = await client.query(
      `INSERT INTO sales (day_id, invoice_no, product_name, quantity, wholesale_price,
                          selling_price, payment_method, sale_date)
       VALUES ($1, 'INV-' || lpad(nextval('invoice_seq')::text, 5, '0'), $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [day.id, canonical, qty, wholesale, price, payment, day.day_date]);
    return rows[0];
  });
  res.status(201).json({ sale: mapSale(sale) });
}));

router.put("/:id", wrap(async (req, res) => {
  const found = await db.query("SELECT * FROM sales WHERE id = $1", [req.params.id]);
  if (!found.rows.length) throw new HttpError(404, "sale_not_found", "Sale not found");

  const product   = cleanText(req.body.product ?? req.body.product_name, { field: "product", max: 80 });
  const qty       = toInt(req.body.qty ?? req.body.quantity, { field: "qty" });
  const price     = toMoney(req.body.price ?? req.body.selling_price, { field: "price" });
  const wholesale = toMoney(req.body.wholesale ?? req.body.wholesale_price ?? 0, { field: "wholesale" });
  const payment   = await validPayment(req.body.payment ?? req.body.payment_method);

  const sale = await db.tx(async client => {
    const canonical = await rememberName(client, product);
    const { rows } = await client.query(
      `UPDATE sales SET product_name = $1, quantity = $2, wholesale_price = $3,
                        selling_price = $4, payment_method = $5, updated_at = now()
        WHERE id = $6 RETURNING *`,
      [canonical, qty, wholesale, price, payment, req.params.id]);
    return rows[0];
  });
  res.json({ sale: mapSale(sale) });
}));

router.delete("/:id", wrap(async (req, res) => {
  const found = await db.query("SELECT * FROM sales WHERE id = $1", [req.params.id]);
  if (!found.rows.length) throw new HttpError(404, "sale_not_found", "Sale not found");
  await db.query("DELETE FROM sales WHERE id = $1", [req.params.id]);
  res.json({ ok: true, id: String(req.params.id) });
}));

module.exports = router;
