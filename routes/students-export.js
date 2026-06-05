// routes/students-export.js
// Owns: CSV export of all active-season students with financial data.
// Does NOT own: student CRUD, formula definitions, payment entry mutations.

const express = require('express');

module.exports = function createStudentsExportRouter({ pool, requireAuth }) {
  const router = express.Router();

  // GET /api/students/export-csv
  // Full student list for active season, including financial totals.
  // PRÉSIDENT + DIRECTRICE only. No client-side filters — always exports complete list.
  router.get('/export-csv', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      // Resolve active saison
      const saisonRes = await pool.query(`SELECT id FROM saisons WHERE active = TRUE LIMIT 1`);
      if (saisonRes.rows.length === 0) {
        return res.status(404).json({ error: 'Aucune saison active' });
      }
      const saisonId = saisonRes.rows[0].id;

      // One query: students enrolled in active saison with computed financial totals.
      // montant_du logic mirrors routes/payments.js GET /batch exactly.
      const result = await pool.query(`
        SELECT
          s.last_name                                                           AS nom,
          s.first_name                                                          AS prenom,
          TO_CHAR(s.birth_date, 'DD/MM/YYYY')                                 AS date_naissance,
          COALESCE(s.email, '')                                                AS email,
          COALESCE(s.phone, '')                                                AS telephone,
          COALESCE(f.label, '')                                                AS formule,
          CASE WHEN ss.adhesion_incluse = false THEN 'Non' ELSE 'Oui' END     AS adhesion,
          ROUND(
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
            END::numeric / 100, 2
          )                                                                    AS montant_du,
          ROUND(
            COALESCE((
              SELECT SUM(pe.amount_cents)
              FROM payment_entries pe
              WHERE pe.student_id = s.id AND pe.saison_id = sa.id
            ), 0)::numeric / 100, 2
          )                                                                    AS montant_paye,
          TO_CHAR(ss.created_at, 'DD/MM/YYYY')                               AS date_inscription,
          COALESCE(ARRAY_TO_STRING(s.practice_levels, ', '), '')              AS niveau
        FROM students s
        JOIN student_saisons ss ON s.id = ss.student_id
        JOIN saisons sa ON ss.saison_id = sa.id AND sa.active = TRUE
        LEFT JOIN formulas f ON ss.formule_id = f.id
        WHERE s.active = TRUE
        ORDER BY s.last_name, s.first_name
      `, []);

      // Build CSV rows
      const headers = [
        'Nom',
        'Prénom',
        'Date de naissance',
        'Email',
        'Téléphone',
        'Formule',
        'Adhésion (Oui/Non)',
        'Montant dû (€)',
        'Montant payé (€)',
        'Restant dû (€)',
        'Date inscription',
        'Niveau',
      ];

      const csvRows = [headers];

      for (const row of result.rows) {
        const montantDu = parseFloat(row.montant_du) || 0;
        const montantPaye = parseFloat(row.montant_paye) || 0;
        const restantDu = Math.max(0, montantDu - montantPaye);

        csvRows.push([
          row.nom || '',
          row.prenom || '',
          row.date_naissance || '',
          row.email || '',
          row.telephone || '',
          row.formule || '',
          row.adhesion || '',
          montantDu.toFixed(2).replace('.', ','),
          montantPaye.toFixed(2).replace('.', ','),
          restantDu.toFixed(2).replace('.', ','),
          row.date_inscription || '',
          row.niveau || '',
        ]);
      }

      // Serialize as semicolon-separated CSV (FR standard)
      // Wrap fields in double-quotes; escape any embedded double-quotes by doubling them.
      const csvContent = csvRows
        .map(cols =>
          cols.map(v => {
            const s = String(v);
            // Quote if contains semicolon, quote, newline, or leading/trailing whitespace
            if (/[;"\n\r]/.test(s) || s !== s.trim()) {
              return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
          }).join(';')
        )
        .join('\r\n');

      // UTF-8 BOM for Excel FR compatibility
      const BOM = '\uFEFF';
      const output = BOM + csvContent;

      const dateStr = new Date().toISOString().split('T')[0];
      const filename = `eleves_lacademie_${dateStr}.csv`;

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(Buffer.from(output, 'utf8'));
    } catch (err) {
      console.error('[students-export] GET /export-csv error:', err);
      res.status(500).json({ error: 'Erreur lors de l\'export CSV' });
    }
  });

  return router;
};
