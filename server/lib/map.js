"use strict";
/* Database rows -> the shapes the existing frontend already renders.
   Keeping these names identical is what lets the UI code stay untouched. */

const str = v => (v === null || v === undefined ? null : String(v));
const iso = v => (v instanceof Date ? v.toISOString() : v);

const mapSale = r => ({
  id:        str(r.id),
  invoice:   r.invoice_no,
  product:   r.product_name,
  qty:       r.quantity,
  price:     Number(r.selling_price),
  wholesale: Number(r.wholesale_price),
  total:     Number(r.total),
  cost:      Number(r.wholesale_total),
  profit:    Number(r.profit),
  payment:   r.payment_method,
  sessionId: str(r.day_id),
  date:      r.sale_date,
  time:      iso(r.sale_time)
});

const mapDay = r => ({
  id:        str(r.id),
  dayName:   r.day_name,
  date:      r.day_date,
  startedAt: iso(r.opened_at),
  closedAt:  iso(r.closed_at),
  status:    r.status
});

const mapNote = r => ({
  id:        str(r.id),
  sessionId: str(r.day_id),
  date:      r.note_date,
  text:      r.note_text,
  time:      iso(r.note_time)
});

const mapTotals = r => ({
  total:  Number(r.total  || 0),
  cost:   Number(r.cost   || 0),
  profit: Number(r.profit || 0),
  count:  Number(r.count  || 0),
  cash:   Number(r.cash   || 0),
  card:   Number(r.card   || 0),
  byMethod: r.by_method || {}
});

/* a closed day + its totals is what the Reports screen calls a "report" */
const mapReport = r => ({
  id:        "rep-" + str(r.id),
  sessionId: str(r.id),
  dayName:   r.day_name,
  date:      r.day_date,
  closedAt:  iso(r.closed_at),
  totals:    mapTotals(r)
});

/* One reusable aggregate over a LEFT JOIN of days -> sales.
   Sales only: daily notes are never part of any total. */
const TOTALS_SELECT = `
  COALESCE(SUM(s.total), 0)                                          AS total,
  COALESCE(SUM(s.wholesale_total), 0)                                AS cost,
  COALESCE(SUM(s.profit), 0)                                         AS profit,
  COUNT(s.id)                                                        AS count,
  COALESCE(SUM(s.total) FILTER (WHERE s.payment_method = 'cash'), 0) AS cash,
  COALESCE(SUM(s.total) FILTER (WHERE s.payment_method = 'card'), 0) AS card,
  (SELECT COALESCE(jsonb_object_agg(x.pm, x.amt), '{}'::jsonb)
     FROM (SELECT payment_method AS pm, SUM(total) AS amt
             FROM sales WHERE day_id = d.id GROUP BY 1) x)           AS by_method`;

module.exports = { mapSale, mapDay, mapNote, mapTotals, mapReport, TOTALS_SELECT };
