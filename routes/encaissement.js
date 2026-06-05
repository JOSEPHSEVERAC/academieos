// routes/encaissement.js
// Owns: PWA /encaissement mobile endpoints — student search, financial summary, payment entry creation.
// Does NOT own: student CRUD, formula definitions, attendance, campaign emails.

const express = require('express');
const pe = require('../db/payment-entries');

module.exports = function createEncaissementRouter({ pool, requireAuth, logAudit }) {
  const router = express.Router();

  const ROLES = ['PRÉSIDENT', 'DIRECTRICE'];

  // ── Helpers ─────────────────────────────────────────────────────────────────

  async function getActiveSaison(client) {
    const res = await client.query(
      `SELECT id, date_debut, date_fin FROM saisons WHERE active = TRUE LIMIT 1`
    );
    if (res.rows.length === 0) throw Object.assign(new Error('Aucune saison active'), { status: 404 });
    return res.rows[0];
  }

  // ── GET /api/encaissement/search?q= ─────────────────────────────────────────
  // Search students enrolled in the active saison.
  // Returns: id, first_name, last_name, numero_adherent, formule_label, montant_du_cents, amount_paid_cents
  router.get('/search', requireAuth(ROLES), async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);

    try {
      const saison = await getActiveSaison(pool);

      const result = await pool.query(`
        SELECT
          s.id,
          s.first_name,
          s.last_name,
          s.numero_adherent,
          f.label                   AS formule_label,
          COALESCE((
            SELECT SUM(pe.amount_cents)
            FROM payment_entries pe
            WHERE pe.student_id = s.id AND pe.saison_id = $1
          ), 0)                     AS amount_paid_cents,
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
          END                       AS montant_du_cents
        FROM students s
        JOIN student_saisons ss ON s.id = ss.student_id
        JOIN saisons sa ON ss.saison_id = sa.id AND sa.active = TRUE
        LEFT JOIN formulas f ON ss.formule_id = f.id
        WHERE s.active = TRUE
          AND (
            s.first_name ILIKE $2
            OR s.last_name ILIKE $2
            OR CONCAT(s.first_name, ' ', s.last_name) ILIKE $2
            OR CONCAT(s.last_name, ' ', s.first_name) ILIKE $2
          )
        ORDER BY s.last_name, s.first_name
        LIMIT 10
      `, [saison.id, `%${q}%`]);

      res.json(result.rows);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[encaissement] GET /search error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/encaissement/students/:id ──────────────────────────────────────
  // Full financial summary for one student (active saison) + last 3 entries.
  router.get('/students/:id', requireAuth(ROLES), async (req, res) => {
    try {
      const saison = await getActiveSaison(pool);

      // Student + financial summary
      const studentRes = await pool.query(`
        SELECT
          s.id,
          s.first_name,
          s.last_name,
          s.numero_adherent,
          f.label                   AS formule_label,
          COALESCE((
            SELECT SUM(pe.amount_cents)
            FROM payment_entries pe
            WHERE pe.student_id = s.id AND pe.saison_id = $1
          ), 0)                     AS amount_paid_cents,
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
          END                       AS montant_du_cents
        FROM students s
        JOIN student_saisons ss ON s.id = ss.student_id
        JOIN saisons sa ON ss.saison_id = sa.id AND sa.active = TRUE
        LEFT JOIN formulas f ON ss.formule_id = f.id
        WHERE s.id = $2 AND s.active = TRUE
      `, [saison.id, req.params.id]);

      if (studentRes.rows.length === 0) {
        return res.status(404).json({ error: 'Élève introuvable ou non inscrit cette saison' });
      }

      // Last 3 payment entries
      const entries = await pe.listForStudent(pool, {
        studentId: req.params.id,
        saisonId: saison.id,
      });

      const student = studentRes.rows[0];
      res.json({
        ...student,
        restant_du_cents: Math.max(0, student.montant_du_cents - student.amount_paid_cents),
        recent_entries: entries.slice(0, 3),
      });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[encaissement] GET /students/:id error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/encaissement/students/:id/entries ─────────────────────────────
  // Create a payment entry from the PWA. Identical to /api/payments route but tags source='PWA'.
  // Body: { amount_cents, payment_date, payment_method, notes }
  router.post('/students/:id/entries', requireAuth(ROLES), async (req, res) => {
    const studentId = req.params.id;
    const { amount_cents, payment_date, payment_method, notes } = req.body;

    if (!amount_cents || isNaN(Number(amount_cents)) || Number(amount_cents) <= 0) {
      return res.status(400).json({ error: 'amount_cents requis (entier positif en centimes)' });
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
      const saison = await getActiveSaison(client);

      // Insert with source='PWA'
      const entryRes = await client.query(
        `INSERT INTO payment_entries
           (student_id, saison_id, amount_cents, payment_date, payment_method, notes, created_by, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'PWA')
         RETURNING *`,
        [
          studentId,
          saison.id,
          Math.round(Number(amount_cents)),
          payment_date,
          payment_method,
          notes || null,
          req.user.id,
        ]
      );
      const entry = entryRes.rows[0];

      // Audit log
      const userName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email;
      await client.query(
        `INSERT INTO student_change_log
           (student_id, changed_at, changed_by_user_id, changed_by_name, changed_by_role,
            field_name, old_value, new_value)
         VALUES ($1, NOW(), $2, $3, $4, 'payment_entry_created', NULL, $5)`,
        [
          studentId,
          req.user.id,
          userName,
          req.user.role,
          JSON.stringify({
            entry_id: entry.id,
            amount_cents: entry.amount_cents,
            payment_date: entry.payment_date,
            payment_method: entry.payment_method,
            source: 'PWA',
          }),
        ]
      );

      await client.query('COMMIT');
      res.status(201).json(entry);
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.status) return res.status(err.status).json({ error: err.message });
      console.error('[encaissement] POST /students/:id/entries error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  return router;
};
