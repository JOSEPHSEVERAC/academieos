// routes/student-audit.js
// Owns: validated student-change commits, per-field audit log, financial recalculation on formula change,
//       read-only student lookups (by-lastname address autocomplete).
// Does NOT own: student CRUD (server.js PUT /api/students/:id), saison or formula master data.

const express = require('express');

// ─── Financial recalculation ────────────────────────────────────────────────
// When a formula changes mid-season we split the billing into periods:
//   Period 1  : saison_start  → pivot (today)  — billed at OLD formula price
//   Period 2  : pivot         → saison_end     — billed at NEW formula price
// Rule: tout mois commencé = dû en entier (on each side of the pivot).
// Returns the financial_context object stored on the change-log row and surfaced
// in the confirmation modal.

function monthsElapsed(from, to) {
  // Whole months elapsed from `from` (start of period) to `to` (end of period),
  // where any started month counts as one full month.
  const f = new Date(from);
  const t = new Date(to);
  if (t <= f) return 0;
  const years = t.getFullYear() - f.getFullYear();
  const months = t.getMonth() - f.getMonth();
  let total = years * 12 + months;
  // If the day-of-month in `t` has NOT reached day-of-month in `f`, don't count
  // the partial month — but per rule "tout mois commencé = dû", if day(t) >= day(f)
  // OR there is any remainder at all, count it.
  if (t.getDate() > f.getDate() || (t.getDate() === f.getDate() && t.getHours() >= f.getHours())) {
    total += 1;
  }
  return Math.max(0, total);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function buildFinancialContext({ saisonDateDebut, saisonDateFin, oldFormule, newFormule, pivot }) {
  // Both formules must be 'mensuel' for a monetary recalculation to apply.
  // (Unitaire, unique, famille-bénéficiaire formules are excluded.)
  if (!oldFormule || !newFormule) return null;
  if (oldFormule.periodicite !== 'mensuel' && newFormule.periodicite !== 'mensuel') return null;

  const start  = new Date(saisonDateDebut);
  const end    = new Date(saisonDateFin);
  const today  = new Date(pivot);

  // Constrain today between start and end
  const pivotClamped = new Date(clamp(today.getTime(), start.getTime(), end.getTime()));

  // Period 1: start → pivot (old formula)
  const months1 = clamp(monthsElapsed(start, pivotClamped), 1, 10);
  // Period 2: pivot → end (new formula)
  // Months used in period 1 + period 2 <= 10
  const months2 = clamp(10 - months1, 0, 10);

  const adhesion    = 2500; // cents — always 25€, one-time per saison
  const revOld      = adhesion + (oldFormule.periodicite === 'mensuel' ? oldFormule.prix_cents * 10 : (oldFormule.prix_cents || 0));
  const revNew      = adhesion + (oldFormule.periodicite === 'mensuel' ? oldFormule.prix_cents * months1 : 0)
                    + (newFormule.periodicite === 'mensuel' ? newFormule.prix_cents * months2 : 0);

  return {
    saison_debut:     saisonDateDebut,
    saison_fin:       saisonDateFin,
    pivot:            pivotClamped.toISOString().slice(0, 10),
    old_formule_label: oldFormule.label,
    old_prix_cents:   oldFormule.prix_cents,
    old_months:       10,
    old_revenu_cents: revOld,
    new_formule_label: newFormule.label,
    new_prix_cents:   newFormule.prix_cents,
    period1_months:   months1,
    period2_months:   months2,
    new_revenu_cents: revNew,
    delta_cents:      revNew - revOld,
  };
}

// ─── Router factory ──────────────────────────────────────────────────────────

module.exports = function createStudentAuditRouter({ pool, requireAuth }) {

  const router = express.Router();

  // ── GET /api/students/:id/changes ─────────────────────────────────────────
  // Returns the change log for a student, newest first.
  router.get('/:id/changes', requireAuth(['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR']), async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `SELECT
           id, changed_at, changed_by_name, changed_by_role,
           field_name, old_value, new_value, financial_context
         FROM student_change_log
         WHERE student_id = $1
         ORDER BY changed_at DESC, id DESC
         LIMIT 200`,
        [id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('student-audit GET changes error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/students/:id/changes ────────────────────────────────────────
  // Atomic: update student + log every changed field + recalc finances if formula changed.
  // Body: { changes: [{ field, old_value, new_value }], student_data: { ...PUT body } }
  router.post('/:id/changes', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    const { id } = req.params;
    const { changes, student_data } = req.body;

    if (!Array.isArray(changes) || changes.length === 0) {
      return res.status(400).json({ error: 'Aucune modification à enregistrer' });
    }
    if (!student_data || typeof student_data !== 'object') {
      return res.status(400).json({ error: 'student_data manquant' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // ── 1. Apply the student update (same logic as PUT /api/students/:id) ──
      const {
        first_name, last_name, birth_date, sexe, email, phone,
        parent_name, parent_phone, parent_email, level, notes, active,
        formule, payment_method, address, postal_code, city,
        size_top, size_bottom, shoe_size, practice_levels,
        deux_cours_semaine, date_resiliation, discipline_ids,
        amount_paid_cents,
        adhesion_incluse
      } = student_data;

      const updateRes = await client.query(
        `UPDATE students SET
          first_name        = COALESCE($1, first_name),
          last_name         = COALESCE($2, last_name),
          birth_date        = $3,
          sexe              = COALESCE($4, sexe),
          email             = $5,
          phone             = $6,
          parent_name       = $7,
          parent_phone      = $8,
          parent_email      = $9,
          level             = COALESCE($10, level),
          notes             = $11,
          active            = COALESCE($12, active),
          formule           = $13,
          payment_method    = $14,
          address           = $15,
          postal_code       = $16,
          city              = $17,
          size_top          = $18,
          size_bottom       = $19,
          shoe_size         = $20,
          practice_levels   = COALESCE($21, practice_levels),
          deux_cours_semaine = COALESCE($22, deux_cours_semaine),
          updated_at        = NOW()
         WHERE id = $23 RETURNING *`,
        [
          first_name, last_name, birth_date || null,
          sexe || null, email || null, phone || null,
          parent_name || null, parent_phone || null, parent_email || null,
          level, notes || null, active,
          formule || null, payment_method || null, address || null,
          postal_code || null, city || null,
          size_top || null, size_bottom || null, shoe_size || null,
          practice_levels !== undefined ? (practice_levels.length ? practice_levels : []) : null,
          deux_cours_semaine !== undefined ? deux_cours_semaine === true : null,
          id
        ]
      );

      if (updateRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Élève non trouvé' });
      }

      // ── 2. Disciplines update ──────────────────────────────────────────────
      if (discipline_ids !== undefined) {
        await client.query('DELETE FROM student_disciplines WHERE student_id = $1', [id]);
        if (discipline_ids && discipline_ids.length > 0) {
          for (const dId of discipline_ids) {
            await client.query(
              'INSERT INTO student_disciplines (student_id, discipline_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
              [id, dId]
            );
          }
        }
      }

      // ── 3. student_saisons update + financial recalc ───────────────────────
      let financialContext = null;
      if (formule !== undefined || date_resiliation !== undefined || amount_paid_cents !== undefined || adhesion_incluse !== undefined) {
        const activeSaisonRes = await client.query(
          'SELECT id, date_debut, date_fin FROM saisons WHERE active = TRUE LIMIT 1'
        );
        if (activeSaisonRes.rows.length > 0) {
          const saison = activeSaisonRes.rows[0];
          let newFormuleId = null;
          let newFormuleRow = null;

          if (formule) {
            const fRes = await client.query(
              'SELECT id, label, prix_cents, periodicite, montant_annuel_cents FROM formulas WHERE label = $1',
              [formule]
            );
            if (fRes.rows.length > 0) {
              newFormuleId = fRes.rows[0].id;
              newFormuleRow = fRes.rows[0];
            }
          }

          // Detect formula change to compute financial context
          const formulaChange = changes.find(c => c.field === 'formule');
          if (formulaChange && formulaChange.old_value && formulaChange.new_value
              && formulaChange.old_value !== formulaChange.new_value) {
            const oldFRes = await client.query(
              'SELECT id, label, prix_cents, periodicite, montant_annuel_cents FROM formulas WHERE label = $1',
              [formulaChange.old_value]
            );
            const oldFormuleRow = oldFRes.rows[0] || null;
            if (oldFormuleRow && newFormuleRow) {
              financialContext = buildFinancialContext({
                saisonDateDebut: saison.date_debut,
                saisonDateFin:   saison.date_fin,
                oldFormule:      oldFormuleRow,
                newFormule:      newFormuleRow,
                pivot:           new Date().toISOString(),
              });
            }
          }

          const adhesionVal = adhesion_incluse !== undefined ? (adhesion_incluse !== false) : true;
          await client.query(
            `INSERT INTO student_saisons (student_id, saison_id, adhesion_payee, formule_id, date_resiliation, amount_paid_cents, adhesion_incluse)
             VALUES ($1, $2, false, $3, $4, $5, $6)
             ON CONFLICT (student_id, saison_id) DO UPDATE SET
               formule_id       = CASE WHEN $3 IS NOT NULL THEN $3 ELSE student_saisons.formule_id END,
               date_resiliation = $4,
               amount_paid_cents = COALESCE($5, student_saisons.amount_paid_cents),
               adhesion_incluse = $6`,
            [id, saison.id, newFormuleId, date_resiliation !== undefined ? (date_resiliation || null) : null, amount_paid_cents !== undefined ? amount_paid_cents : null, adhesionVal]
          );
        }
      }

      // ── 4. Write change-log rows ───────────────────────────────────────────
      const userName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim()
                     || req.user.email;
      const now = new Date();

      for (const change of changes) {
        // Attach financial context only to the 'formule' row
        const ctx = (change.field === 'formule' && financialContext)
          ? JSON.stringify(financialContext)
          : null;

        await client.query(
          `INSERT INTO student_change_log
             (student_id, changed_at, changed_by_user_id, changed_by_name, changed_by_role,
              field_name, old_value, new_value, financial_context)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            id, now,
            req.user.id, userName, req.user.role,
            change.field,
            change.old_value !== undefined ? String(change.old_value ?? '') : '',
            change.new_value !== undefined ? String(change.new_value ?? '') : '',
            ctx
          ]
        );
      }

      await client.query('COMMIT');

      // Re-fetch student with disciplines
      const fullStudent = await pool.query(
        `SELECT s.*,
           COALESCE(json_agg(
             json_build_object('id', d.id, 'name', d.name, 'color', d.color)
           ) FILTER (WHERE d.id IS NOT NULL), '[]') AS disciplines
         FROM students s
         LEFT JOIN student_disciplines sd ON s.id = sd.student_id
         LEFT JOIN disciplines d ON sd.discipline_id = d.id
         WHERE s.id = $1
         GROUP BY s.id`,
        [id]
      );

      // Attach adhesion_incluse from student_saisons to the returned student
      const studentRow = fullStudent.rows[0];
      try {
        const ssRes = await pool.query(
          `SELECT amount_paid_cents, adhesion_incluse FROM student_saisons ss
           JOIN saisons s ON ss.saison_id = s.id
           WHERE ss.student_id = $1 AND s.active = TRUE LIMIT 1`,
          [id]
        );
        if (ssRes.rows.length > 0) {
          studentRow.amount_paid_cents = ssRes.rows[0].amount_paid_cents;
          studentRow.adhesion_incluse = ssRes.rows[0].adhesion_incluse !== false;
        } else {
          studentRow.adhesion_incluse = true;
        }
      } catch (_) { studentRow.adhesion_incluse = true; }

      res.json({
        student: studentRow,
        financial_context: financialContext,
        changes_logged: changes.length,
      });

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('student-audit POST changes error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/students/by-lastname?last_name=X ─────────────────────────────
  // Returns active students sharing the same last name, with their address fields.
  // Used by the inscription form to suggest address auto-fill for same-family members.
  // Match is case- and accent-insensitive via unaccent + LOWER.
  router.get('/by-lastname', requireAuth(), async (req, res) => {
    const { last_name } = req.query;
    if (!last_name || last_name.trim().length < 2) return res.json([]);
    try {
      const result = await pool.query(
        `SELECT id, first_name, last_name, address, postal_code, city
         FROM students
         WHERE active = true
           AND LOWER(unaccent(last_name)) = LOWER(unaccent($1))
         ORDER BY last_name, first_name
         LIMIT 10`,
        [last_name.trim()]
      );
      res.json(result.rows);
    } catch (err) {
      // unaccent extension may not exist — fall back to basic LOWER comparison
      if (err.message && err.message.includes('unaccent')) {
        try {
          const fallback = await pool.query(
            `SELECT id, first_name, last_name, address, postal_code, city
             FROM students
             WHERE active = true
               AND LOWER(last_name) = LOWER($1)
             ORDER BY last_name, first_name
             LIMIT 10`,
            [last_name.trim()]
          );
          return res.json(fallback.rows);
        } catch (e2) {
          console.error('[student-audit] GET /by-lastname fallback error:', e2);
          return res.status(500).json({ error: 'Erreur serveur' });
        }
      }
      console.error('[student-audit] GET /by-lastname error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};
