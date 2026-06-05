// db/payment-entries.js
// Owns: payment_entries table — individual dated payment records per student/saison.
// Does NOT own: student_saisons.amount_paid_cents (now derived), student profiles, formulas.

const ALLOWED_METHODS = ['espèces', 'chèque', 'virement', 'CB', 'prélèvement'];

/**
 * List payment entries for a student on their active saison.
 * Returns entries sorted by payment_date DESC.
 */
async function listForStudent(pool, { studentId, saisonId }) {
  const res = await pool.query(
    `SELECT
       pe.id,
       pe.amount_cents,
       pe.payment_date,
       pe.payment_method,
       pe.notes,
       pe.created_at,
       u.first_name AS created_by_first_name,
       u.last_name  AS created_by_last_name
     FROM payment_entries pe
     LEFT JOIN app_users u ON pe.created_by = u.id
     WHERE pe.student_id = $1 AND pe.saison_id = $2
     ORDER BY pe.payment_date DESC, pe.created_at DESC`,
    [studentId, saisonId]
  );
  return res.rows;
}

/**
 * Get the SUM of all entries for a student on a saison (their computed amount_paid_cents).
 */
async function sumForStudent(pool, { studentId, saisonId }) {
  const res = await pool.query(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total
     FROM payment_entries
     WHERE student_id = $1 AND saison_id = $2`,
    [studentId, saisonId]
  );
  return parseInt(res.rows[0].total, 10);
}

/**
 * Get the most recent payment entry per student for a list of student IDs on a saison.
 * Used by the batch payments page to show "Dernier paiement".
 * Returns a map: studentId -> { payment_date, payment_method, amount_cents }
 */
async function lastPaymentByStudents(pool, { saisonId }) {
  const res = await pool.query(
    `SELECT DISTINCT ON (student_id)
       student_id,
       payment_date,
       payment_method,
       amount_cents
     FROM payment_entries
     WHERE saison_id = $1
     ORDER BY student_id, payment_date DESC, created_at DESC`,
    [saisonId]
  );
  const map = {};
  res.rows.forEach(r => { map[r.student_id] = r; });
  return map;
}

/**
 * Create a new payment entry. Returns the created row.
 * Validates payment_method against allowlist.
 */
async function create(pool, { studentId, saisonId, amountCents, paymentDate, paymentMethod, notes, createdBy }) {
  if (!ALLOWED_METHODS.includes(paymentMethod)) {
    throw new Error(`Méthode de paiement invalide: ${paymentMethod}`);
  }

  const res = await pool.query(
    `INSERT INTO payment_entries
       (student_id, saison_id, amount_cents, payment_date, payment_method, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [studentId, saisonId, amountCents, paymentDate, paymentMethod, notes || null, createdBy || null]
  );
  return res.rows[0];
}

/**
 * Update an existing payment entry (amount, date, method, notes).
 * Only the entry owner's saison/student association is checked by the caller.
 */
async function update(pool, { id, amountCents, paymentDate, paymentMethod, notes }) {
  if (!ALLOWED_METHODS.includes(paymentMethod)) {
    throw new Error(`Méthode de paiement invalide: ${paymentMethod}`);
  }

  const res = await pool.query(
    `UPDATE payment_entries
     SET amount_cents = $1, payment_date = $2, payment_method = $3, notes = $4
     WHERE id = $5
     RETURNING *`,
    [amountCents, paymentDate, paymentMethod, notes || null, id]
  );
  return res.rows[0] || null;
}

/**
 * Delete a payment entry by ID. Returns true if deleted.
 */
async function remove(pool, { id }) {
  const res = await pool.query(
    `DELETE FROM payment_entries WHERE id = $1 RETURNING id`,
    [id]
  );
  return res.rows.length > 0;
}

/**
 * Get a single entry by ID (for ownership verification before edit/delete).
 */
async function getById(pool, { id }) {
  const res = await pool.query(
    `SELECT * FROM payment_entries WHERE id = $1`,
    [id]
  );
  return res.rows[0] || null;
}

module.exports = {
  ALLOWED_METHODS,
  listForStudent,
  sumForStudent,
  lastPaymentByStudents,
  create,
  update,
  remove,
  getById,
};
