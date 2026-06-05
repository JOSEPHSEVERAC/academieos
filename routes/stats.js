// routes/stats.js
// Owns: attendance statistics aggregates + revenue-by-formula + recovery KPIs for the dashboard.
// Does NOT own: attendance CRUD (server.js), class definitions (server.js), student data.

const express = require('express');

module.exports = function createStatsRouter({ pool, requireAuth }) {
  const router = express.Router();

  // GET /api/stats/attendance
  // Returns:
  //   rate_7d       — % présents sur les 7 derniers jours (null si aucune donnée)
  //   rate_30d      — % présents sur les 30 derniers jours (null si aucune donnée)
  //   top5          — top 5 cours par taux de présence (30 j), [{class_id, label, location, rate, present, total}]
  //   at_risk       — cours < 50 % présence sur 30 j, même shape que top5
  //   by_class      — tous les cours ayant ≥1 enreg (30 j), triés par taux desc, pour le graphique
  router.get('/attendance', async (req, res) => {
    try {
      // ── Taux global 7 jours ──────────────────────────────────────────────────
      const r7 = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'present') AS present_count,
          COUNT(*) AS total_count
        FROM attendance
        WHERE session_date >= CURRENT_DATE - INTERVAL '7 days'
      `);
      const p7 = parseInt(r7.rows[0].present_count, 10);
      const t7 = parseInt(r7.rows[0].total_count, 10);
      const rate_7d = t7 > 0 ? Math.round((p7 / t7) * 100) : null;

      // ── Taux global 30 jours ─────────────────────────────────────────────────
      const r30 = await pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'present') AS present_count,
          COUNT(*) AS total_count
        FROM attendance
        WHERE session_date >= CURRENT_DATE - INTERVAL '30 days'
      `);
      const p30 = parseInt(r30.rows[0].present_count, 10);
      const t30 = parseInt(r30.rows[0].total_count, 10);
      const rate_30d = t30 > 0 ? Math.round((p30 / t30) * 100) : null;

      // ── Par cours — 30 jours ─────────────────────────────────────────────────
      // Join classes → disciplines + locations for labels.
      // Only include classes with ≥1 attendance record in the window.
      const rByClass = await pool.query(`
        SELECT
          c.id                                        AS class_id,
          d.name                                      AS discipline,
          c.secondary_label,
          l.city                                      AS location,
          c.start_time,
          c.day_of_week,
          COUNT(*) FILTER (WHERE a.status = 'present') AS present_count,
          COUNT(*)                                    AS total_count
        FROM attendance a
        JOIN classes c ON c.id = a.class_id
        JOIN disciplines d ON d.id = c.discipline_id
        JOIN locations l ON l.id = c.location_id
        WHERE a.session_date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY c.id, d.name, c.secondary_label, l.city, c.start_time, c.day_of_week
        HAVING COUNT(*) > 0
        ORDER BY (COUNT(*) FILTER (WHERE a.status = 'present')::float / COUNT(*)) DESC
      `);

      const DAY_NAMES = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

      const by_class = rByClass.rows.map(r => {
        const present = parseInt(r.present_count, 10);
        const total   = parseInt(r.total_count, 10);
        const rate    = total > 0 ? Math.round((present / total) * 100) : 0;
        const timeStr = r.start_time ? r.start_time.slice(0, 5) : '';
        const dayStr  = DAY_NAMES[r.day_of_week] || '';
        // Build a human-readable label: "Jazz — Jeu 17h00 — Arcachon"
        const label   = [
          r.secondary_label ? `${r.discipline} — ${r.secondary_label}` : r.discipline,
          dayStr && timeStr ? `${dayStr} ${timeStr}` : (dayStr || timeStr),
          r.location
        ].filter(Boolean).join(' · ');

        return { class_id: r.class_id, label, location: r.location, rate, present, total };
      });

      const top5    = by_class.slice(0, 5);
      const at_risk = by_class.filter(c => c.rate < 50);

      res.json({ rate_7d, rate_30d, top5, at_risk, by_class });
    } catch (err) {
      console.error('[stats] GET /attendance error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/stats/revenue-by-formula
  // Returns per-formula revenue breakdown for the active season.
  // Restricted to PRÉSIDENT + DIRECTRICE — contains financial data.
  //
  // Each row: { formule_id, formule_nom, nb_eleves, montant_du_cents, montant_paye_cents, restant_cents }
  // Sorted by montant_du_cents DESC.
  // montant_du uses the same prorata logic as /api/stats (mois restants × prix + adhésion).
  // montant_paye sums from payment_entries (source of truth).
  router.get('/revenue-by-formula', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const result = await pool.query(`
        WITH active_saison AS (
          SELECT id, date_debut FROM saisons WHERE active = TRUE LIMIT 1
        ),
        montant_du_par_eleve AS (
          SELECT
            ss.id AS ss_id,
            ss.formule_id,
            CASE
              WHEN f.periodicite = 'mensuel' THEN
                2500 + f.prix_cents * CASE
                  WHEN ss.date_resiliation IS NOT NULL THEN
                    GREATEST(1, LEAST(10,
                      EXTRACT(MONTH FROM AGE(ss.date_resiliation::date, sa.date_debut::date))::integer + 1
                    ))
                  ELSE 10
                END
              WHEN f.periodicite LIKE '%unit%' THEN
                2500 + 1500 * COALESCE(ss.cours_unite_count, 0)
              WHEN f.periodicite = 'unique' THEN f.prix_cents
              ELSE 0
            END AS montant_du_cents
          FROM student_saisons ss
          JOIN active_saison sa ON ss.saison_id = sa.id
          LEFT JOIN formulas f ON ss.formule_id = f.id
        ),
        paye_par_eleve AS (
          SELECT ss.id AS ss_id, ss.formule_id,
            COALESCE(SUM(pe.amount_cents), 0) AS montant_paye_cents
          FROM student_saisons ss
          JOIN active_saison sa ON ss.saison_id = sa.id
          LEFT JOIN payment_entries pe ON pe.student_id = ss.student_id AND pe.saison_id = sa.id
          GROUP BY ss.id, ss.formule_id
        )
        SELECT
          COALESCE(f.id::text, 'sans_formule')      AS formule_id,
          COALESCE(f.label, 'Sans formule')            AS formule_nom,
          COUNT(*)::int                              AS nb_eleves,
          COALESCE(SUM(md.montant_du_cents), 0)::bigint  AS montant_du_cents,
          COALESCE(SUM(pp.montant_paye_cents), 0)::bigint AS montant_paye_cents
        FROM montant_du_par_eleve md
        JOIN paye_par_eleve pp ON pp.ss_id = md.ss_id
        LEFT JOIN formulas f ON f.id = md.formule_id
        GROUP BY f.id, f.label
        ORDER BY SUM(md.montant_du_cents) DESC NULLS LAST
      `);

      const rows = result.rows.map(r => {
        const du    = parseInt(r.montant_du_cents, 10);
        const paye  = parseInt(r.montant_paye_cents, 10);
        const restant = du - paye;
        const taux  = du > 0 ? Math.round((paye / du) * 100) : 0;
        return {
          formule_id:        r.formule_id,
          formule_nom:       r.formule_nom,
          nb_eleves:         r.nb_eleves,
          montant_du_cents:  du,
          montant_paye_cents: paye,
          restant_cents:     restant,
          taux_recouvrement: taux,
        };
      });

      res.json(rows);
    } catch (err) {
      console.error('[stats] GET /revenue-by-formula error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/stats/recovery
  // Returns global recovery KPIs for the active season:
  //   unpaid_count       — number of students with remaining > 0
  //   total_remaining_cents — sum of all outstanding balances
  //   total_paid_cents   — sum of all payments received
  //   total_due_cents    — sum of all amounts due
  //   last_payment_date  — ISO date of most recent payment_entry (null if none)
  //   last_payment_cents — amount of most recent payment_entry (null if none)
  //
  // Restricted to PRÉSIDENT + DIRECTRICE — financial data.
  router.get('/recovery', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      // Aggregate by student: compute due, paid, remaining per enrollment in active season
      const agg = await pool.query(`
        WITH active_saison AS (
          SELECT id, date_debut FROM saisons WHERE active = TRUE LIMIT 1
        ),
        due_per_student AS (
          SELECT
            s.id AS student_id,
            CASE
              WHEN f.periodicite = 'mensuel' THEN
                2500 + f.prix_cents * CASE
                  WHEN ss.date_resiliation IS NOT NULL THEN
                    GREATEST(1, LEAST(10,
                      EXTRACT(MONTH FROM AGE(ss.date_resiliation::date, sa.date_debut::date))::integer + 1
                    ))
                  ELSE 10
                END
              WHEN f.periodicite LIKE '%unit%' THEN
                2500 + 1500 * COALESCE(ss.cours_unite_count, 0)
              WHEN f.periodicite = 'unique' THEN f.prix_cents
              ELSE 0
            END AS montant_du_cents
          FROM student_saisons ss
          JOIN active_saison sa ON ss.saison_id = sa.id
          JOIN students s ON s.id = ss.student_id
          LEFT JOIN formulas f ON f.id = ss.formule_id
        ),
        paid_per_student AS (
          SELECT
            pe.student_id,
            COALESCE(SUM(pe.amount_cents), 0) AS montant_paye_cents
          FROM payment_entries pe
          JOIN active_saison sa ON pe.saison_id = sa.id
          GROUP BY pe.student_id
        ),
        per_student AS (
          SELECT
            d.student_id,
            d.montant_du_cents AS due,
            COALESCE(p.montant_paye_cents, 0) AS paid,
            d.montant_du_cents - COALESCE(p.montant_paye_cents, 0) AS remaining
          FROM due_per_student d
          LEFT JOIN paid_per_student p ON p.student_id = d.student_id
        )
        SELECT
          COUNT(CASE WHEN remaining > 0 THEN 1 END)::int AS unpaid_count,
          COALESCE(SUM(CASE WHEN remaining > 0 THEN remaining ELSE 0 END), 0)::bigint AS total_remaining_cents,
          COALESCE(SUM(paid), 0)::bigint AS total_paid_cents,
          COALESCE(SUM(due), 0)::bigint AS total_due_cents
        FROM per_student
      `);

      // Last payment received across the active season
      const last = await pool.query(`
        SELECT pe.amount_cents, pe.payment_date
        FROM payment_entries pe
        JOIN saisons sa ON sa.id = pe.saison_id
        WHERE sa.active = TRUE
        ORDER BY pe.payment_date DESC, pe.id DESC
        LIMIT 1
      `);

      const row = agg.rows[0];
      const lastRow = last.rows[0] || null;

      res.json({
        unpaid_count:          parseInt(row.unpaid_count, 10),
        total_remaining_cents: parseInt(row.total_remaining_cents, 10),
        total_paid_cents:      parseInt(row.total_paid_cents, 10),
        total_due_cents:       parseInt(row.total_due_cents, 10),
        last_payment_date:     lastRow ? lastRow.payment_date : null,
        last_payment_cents:    lastRow ? parseInt(lastRow.amount_cents, 10) : null,
      });
    } catch (err) {
      console.error('[stats] GET /recovery error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};
