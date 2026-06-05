// routes/payments.js
// Owns: batch payment list, per-student payment entries (CRUD).
// Does NOT own: student CRUD, formula definitions, season management.

const express = require('express');
const pe = require('../db/payment-entries');

module.exports = function createPaymentsRouter({ pool, requireAuth, logAudit }) {
  const router = express.Router();

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Fetch the active saison ID or throw */
  async function getActiveSaisonId(client) {
    const res = await client.query('SELECT id FROM saisons WHERE active = TRUE LIMIT 1');
    if (res.rows.length === 0) throw Object.assign(new Error('Aucune saison active'), { status: 404 });
    return res.rows[0].id;
  }

  // ── GET /api/payments/batch ─────────────────────────────────────────────────
  // Returns all active-season students with computed montant_du and paid total (from entries).
  // Also includes last_payment_date and last_payment_method.
  router.get('/batch', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      // Get active saison first (for lastPaymentByStudents lookup)
      const saisonRes = await pool.query('SELECT id FROM saisons WHERE active = TRUE LIMIT 1');
      if (saisonRes.rows.length === 0) {
        return res.json([]);
      }
      const saisonId = saisonRes.rows[0].id;

      const result = await pool.query(`
        SELECT
          s.id,
          s.first_name,
          s.last_name,
          s.numero_adherent,
          f.label          AS formule_label,
          f.periodicite    AS formule_periodicite,
          f.prix_cents     AS formule_prix_cents,
          f.montant_annuel_cents,
          ss.adhesion_incluse,
          ss.adhesion_payee,
          ss.date_resiliation,
          ss.cours_unite_count,
          sa.date_debut,
          sa.date_fin,
          COALESCE((
            SELECT SUM(pe.amount_cents)
            FROM payment_entries pe
            WHERE pe.student_id = s.id AND pe.saison_id = sa.id
          ), 0) AS amount_paid_cents,
          CASE
            WHEN f.periodicite = 'mensuel' THEN
              GREATEST(1, LEAST(10,
                CASE
                  WHEN ss.date_resiliation IS NOT NULL
                    THEN EXTRACT(MONTH FROM AGE(ss.date_resiliation::date, sa.date_debut::date))::integer + 1
                  ELSE
                    GREATEST(1, LEAST(10,
                      EXTRACT(MONTH FROM AGE(NOW()::date, sa.date_debut::date))::integer + 1
                    ))
                END
              ))
            ELSE NULL
          END AS mois_restants,
          CASE
            WHEN f.periodicite = 'mensuel' THEN
              (CASE WHEN ss.adhesion_incluse = false THEN 0 ELSE 2500 END)
              + f.prix_cents * GREATEST(1, LEAST(10,
                  CASE
                    WHEN ss.date_resiliation IS NOT NULL
                      THEN EXTRACT(MONTH FROM AGE(ss.date_resiliation::date, sa.date_debut::date))::integer + 1
                    ELSE
                      GREATEST(1, LEAST(10,
                        EXTRACT(MONTH FROM AGE(NOW()::date, sa.date_debut::date))::integer + 1
                      ))
                  END
                ))
            WHEN f.periodicite LIKE '%unit%' THEN
              (CASE WHEN ss.adhesion_incluse = false THEN 0 ELSE 2500 END)
              + 1500 * COALESCE(ss.cours_unite_count, 0)
            WHEN f.periodicite = 'unique' THEN f.prix_cents
            ELSE
              (CASE WHEN ss.adhesion_incluse = false THEN 0 ELSE 2500 END)
          END AS montant_du_cents
        FROM students s
        JOIN student_saisons ss ON s.id = ss.student_id
        JOIN saisons sa ON ss.saison_id = sa.id AND sa.active = TRUE
        LEFT JOIN formulas f ON ss.formule_id = f.id
        WHERE s.active = TRUE
        ORDER BY s.last_name, s.first_name
      `);

      // Attach last payment info
      const lastMap = await pe.lastPaymentByStudents(pool, { saisonId });
      const rows = result.rows.map(r => ({
        ...r,
        last_payment: lastMap[r.id] || null,
      }));

      res.json(rows);
    } catch (err) {
      console.error('[payments] GET /batch error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/payments/students/:id/entries ──────────────────────────────────
  // List all payment entries for a student (active saison).
  router.get('/students/:id/entries', requireAuth(['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR']), async (req, res) => {
    try {
      const saisonId = await getActiveSaisonId(pool);
      const entries = await pe.listForStudent(pool, {
        studentId: req.params.id,
        saisonId,
      });
      const total = entries.reduce((sum, e) => sum + e.amount_cents, 0);
      res.json({ entries, total_paid_cents: total, saison_id: saisonId });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[payments] GET /students/:id/entries error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/payments/students/:id/entries ─────────────────────────────────
  // Create a new payment entry for a student.
  // Body: { amount_cents, payment_date, payment_method, notes }
  router.post('/students/:id/entries', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    const studentId = req.params.id;
    const { amount_cents, payment_date, payment_method, notes } = req.body;

    if (!amount_cents || isNaN(Number(amount_cents))) {
      return res.status(400).json({ error: 'amount_cents requis (entier en centimes)' });
    }
    if (!payment_date) {
      return res.status(400).json({ error: 'payment_date requis (YYYY-MM-DD)' });
    }
    if (!payment_method || !pe.ALLOWED_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method invalide. Valeurs: ${pe.ALLOWED_METHODS.join(', ')}` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const saisonId = await getActiveSaisonId(client);

      const entry = await pe.create(pool, {
        studentId,
        saisonId,
        amountCents: Math.round(Number(amount_cents)),
        paymentDate: payment_date,
        paymentMethod: payment_method,
        notes,
        createdBy: req.user.id,
      });

      // Audit log
      const userName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email;
      await client.query(
        `INSERT INTO student_change_log
           (student_id, changed_at, changed_by_user_id, changed_by_name, changed_by_role,
            field_name, old_value, new_value)
         VALUES ($1, NOW(), $2, $3, $4, 'payment_entry_created', NULL, $5)`,
        [studentId, req.user.id, userName, req.user.role,
          JSON.stringify({ entry_id: entry.id, amount_cents: entry.amount_cents, payment_date: entry.payment_date, payment_method: entry.payment_method })]
      );

      await client.query('COMMIT');
      res.status(201).json(entry);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[payments] POST /students/:id/entries error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  // ── PATCH /api/payments/entries/:entryId ─────────────────────────────────────
  // Update an existing payment entry. PRÉSIDENT + DIRECTRICE only.
  router.patch('/entries/:entryId', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    const { entryId } = req.params;
    const { amount_cents, payment_date, payment_method, notes } = req.body;

    if (amount_cents === undefined || isNaN(Number(amount_cents))) {
      return res.status(400).json({ error: 'amount_cents requis' });
    }
    if (!payment_date) {
      return res.status(400).json({ error: 'payment_date requis' });
    }
    if (!payment_method || !pe.ALLOWED_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: `payment_method invalide. Valeurs: ${pe.ALLOWED_METHODS.join(', ')}` });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Verify entry exists
      const existing = await pe.getById(pool, { id: entryId });
      if (!existing) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Entrée introuvable' });
      }

      const updated = await pe.update(pool, {
        id: entryId,
        amountCents: Math.round(Number(amount_cents)),
        paymentDate: payment_date,
        paymentMethod: payment_method,
        notes,
      });

      // Audit log
      const userName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email;
      await client.query(
        `INSERT INTO student_change_log
           (student_id, changed_at, changed_by_user_id, changed_by_name, changed_by_role,
            field_name, old_value, new_value)
         VALUES ($1, NOW(), $2, $3, $4, 'payment_entry_updated', $5, $6)`,
        [existing.student_id, req.user.id, userName, req.user.role,
          JSON.stringify({ amount_cents: existing.amount_cents, payment_date: existing.payment_date }),
          JSON.stringify({ amount_cents: updated.amount_cents, payment_date: updated.payment_date })]
      );

      await client.query('COMMIT');
      res.json(updated);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[payments] PATCH /entries/:entryId error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  // ── DELETE /api/payments/entries/:entryId ────────────────────────────────────
  // Delete a payment entry. PRÉSIDENT + DIRECTRICE only.
  router.delete('/entries/:entryId', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    const { entryId } = req.params;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await pe.getById(pool, { id: entryId });
      if (!existing) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Entrée introuvable' });
      }

      await pe.remove(pool, { id: entryId });

      // Audit log
      const userName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email;
      await client.query(
        `INSERT INTO student_change_log
           (student_id, changed_at, changed_by_user_id, changed_by_name, changed_by_role,
            field_name, old_value, new_value)
         VALUES ($1, NOW(), $2, $3, $4, 'payment_entry_deleted', $5, NULL)`,
        [existing.student_id, req.user.id, userName, req.user.role,
          JSON.stringify({ entry_id: existing.id, amount_cents: existing.amount_cents, payment_date: existing.payment_date, payment_method: existing.payment_method })]
      );

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[payments] DELETE /entries/:entryId error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  // ── PATCH /api/payments/:id/payment (DEPRECATED — kept for compatibility) ───
  // The old single-amount endpoint. Now creates a payment_entry instead of overwriting.
  // The /paiements page has been updated to not use this, but left for safety.
  router.patch('/:id/payment', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    res.status(410).json({
      error: 'Endpoint obsolète. Utilisez POST /api/payments/students/:id/entries à la place.',
    });
  });

  return router;
};
