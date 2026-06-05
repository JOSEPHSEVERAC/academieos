// routes/comparatif.js
// Owns: inter-season comparative dashboard data (revenues, memberships, cancellations).
// Does NOT own: student CRUD, saison definitions, or the diagnostic sante-base endpoint.

const express = require('express');

module.exports = function createComparatifRouter({ pool, requireAuth }) {
  const router = express.Router();

  // GET /api/comparatif/inter-saisons?mode=hebdo|mensuel&anchor_saison_id=<id>
  //
  // Returns KPIs for 3 seasons (n-2, n-1, n) relative to anchor_saison_id (defaults to active).
  // mode=hebdo  → week-by-week, aligned by relative week number (week 1 = first full week of season)
  // mode=mensuel → calendar month aggregates
  //
  // Response shape:
  // {
  //   saisons: [{ id, nom, date_debut, date_fin }]  ← 3 items in chronological order
  //   mode: "hebdo" | "mensuel"
  //   periods: [
  //     {
  //       label: "Semaine 1" | "Septembre"
  //       data: [
  //         { saison_id, saison_nom, revenus_cents, adhesions_payees, resiliations }
  //         × 3 seasons (null-filled when season has no data for that period)
  //       ]
  //     }
  //   ]
  // }
  router.get('/inter-saisons', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const mode = req.query.mode === 'mensuel' ? 'mensuel' : 'hebdo';
      let anchorId = req.query.anchor_saison_id ? parseInt(req.query.anchor_saison_id) : null;

      // ── 1. Fetch all saisons ordered chronologically ────────────────────────
      const saisonsRes = await pool.query(
        `SELECT id, nom, date_debut, date_fin, active
         FROM saisons
         ORDER BY date_debut ASC NULLS LAST, id ASC`
      );
      const allSaisons = saisonsRes.rows;
      if (allSaisons.length === 0) return res.json({ saisons: [], mode, periods: [] });

      // Resolve anchor: default to active saison
      if (!anchorId) {
        const active = allSaisons.find(s => s.active);
        anchorId = active ? active.id : allSaisons[allSaisons.length - 1].id;
      }

      const anchorIdx = allSaisons.findIndex(s => s.id === anchorId);
      if (anchorIdx === -1) return res.status(400).json({ error: 'Saison introuvable' });

      // Pick 3 consecutive seasons ending at anchor (or fewer if not enough history)
      const endIdx = anchorIdx;
      const startIdx = Math.max(0, endIdx - 2);
      const chosenSaisons = allSaisons.slice(startIdx, endIdx + 1);

      // Pad to length 3 with nulls at the beginning if < 3 seasons exist
      while (chosenSaisons.length < 3) {
        chosenSaisons.unshift(null);
      }

      const validSaisons = chosenSaisons.filter(Boolean);
      const validIds = validSaisons.map(s => s.id);

      if (validIds.length === 0) return res.json({ saisons: [], mode, periods: [] });

      // ── 2. Raw KPI data per student_saisons row (with timing info) ──────────
      // We need:
      //   revenues: sum of formulas.montant_annuel_cents per student per saison
      //             (we attribute revenue at created_at time of student_saisons row)
      //   adhesions payées: count where adhesion_payee = true
      //             (we use created_at as the time signal — approximation)
      //   résiliations: count where date_resiliation IS NOT NULL
      //             (we use date_resiliation as the event time)
      //
      // For revenues we don't have actual payment dates — best proxy is
      // formulas.montant_annuel_cents attributed at created_at of student_saisons.
      // This is the same approach used in the financial context of student_change_log.

      const rawRes = await pool.query(
        `SELECT
           ss.saison_id,
           ss.created_at                        AS inscription_at,
           ss.adhesion_payee,
           ss.date_resiliation,
           COALESCE(f.montant_annuel_cents, 0)  AS montant_annuel_cents,
           sa.date_debut
         FROM student_saisons ss
         JOIN saisons sa ON sa.id = ss.saison_id
         LEFT JOIN formulas f ON f.id = ss.formule_id
         WHERE ss.saison_id = ANY($1::int[])`,
        [validIds]
      );

      const rows = rawRes.rows;

      // ── 3. Build period buckets ─────────────────────────────────────────────

      if (mode === 'hebdo') {
        // Relative week number: week 1 = week containing date_debut
        // Max weeks to show: cover the longest season (up to 42 weeks = ~10 months)
        const MAX_WEEKS = 42;

        // Build bucket map: weekNum → saison_id → { revenus_cents, adhesions, resiliations }
        const buckets = {}; // { weekNum: { [saisonId]: {...} } }

        for (const row of rows) {
          if (!row.date_debut) continue; // skip saisons without date_debut
          const debutMs = new Date(row.date_debut).getTime();

          // Adhesion/inscription bucket: week of created_at
          const inscAt = new Date(row.inscription_at).getTime();
          const inscWeek = Math.floor((inscAt - debutMs) / (7 * 24 * 3600 * 1000)) + 1;
          if (inscWeek >= 1 && inscWeek <= MAX_WEEKS) {
            if (!buckets[inscWeek]) buckets[inscWeek] = {};
            if (!buckets[inscWeek][row.saison_id]) {
              buckets[inscWeek][row.saison_id] = { revenus_cents: 0, adhesions_payees: 0, resiliations: 0 };
            }
            buckets[inscWeek][row.saison_id].revenus_cents += row.adhesion_payee ? parseInt(row.montant_annuel_cents) || 0 : 0;
            if (row.adhesion_payee) buckets[inscWeek][row.saison_id].adhesions_payees++;
          }

          // Résiliation bucket: week of date_resiliation
          if (row.date_resiliation) {
            const resilMs = new Date(row.date_resiliation).getTime();
            const resilWeek = Math.floor((resilMs - debutMs) / (7 * 24 * 3600 * 1000)) + 1;
            if (resilWeek >= 1 && resilWeek <= MAX_WEEKS) {
              if (!buckets[resilWeek]) buckets[resilWeek] = {};
              if (!buckets[resilWeek][row.saison_id]) {
                buckets[resilWeek][row.saison_id] = { revenus_cents: 0, adhesions_payees: 0, resiliations: 0 };
              }
              buckets[resilWeek][row.saison_id].resiliations++;
            }
          }
        }

        // Determine the union of weeks that have any data
        const weekNums = Object.keys(buckets).map(Number).sort((a, b) => a - b);
        if (weekNums.length === 0) return res.json({ saisons: chosenSaisons.map(s => s || null), mode, periods: [] });

        const periods = weekNums.map(w => ({
          label: `Semaine ${w}`,
          week_num: w,
          data: chosenSaisons.map(s => {
            if (!s) return null;
            const d = (buckets[w] || {})[s.id] || { revenus_cents: 0, adhesions_payees: 0, resiliations: 0 };
            return { saison_id: s.id, saison_nom: s.nom, ...d };
          })
        }));

        return res.json({ saisons: chosenSaisons, mode, periods });

      } else {
        // Monthly mode: group by calendar year-month of inscription_at / date_resiliation
        // Build union of year-months across all saisons
        const buckets = {}; // { "2025-09": { [saisonId]: {...} } }

        for (const row of rows) {
          // Adhesion bucket
          const inscDate = new Date(row.inscription_at);
          const inscKey = `${inscDate.getUTCFullYear()}-${String(inscDate.getUTCMonth() + 1).padStart(2, '0')}`;

          if (!buckets[inscKey]) buckets[inscKey] = {};
          if (!buckets[inscKey][row.saison_id]) {
            buckets[inscKey][row.saison_id] = { revenus_cents: 0, adhesions_payees: 0, resiliations: 0 };
          }
          if (row.adhesion_payee) {
            buckets[inscKey][row.saison_id].revenus_cents += parseInt(row.montant_annuel_cents) || 0;
            buckets[inscKey][row.saison_id].adhesions_payees++;
          }

          // Résiliation bucket
          if (row.date_resiliation) {
            const resilDate = new Date(row.date_resiliation);
            const resilKey = `${resilDate.getUTCFullYear()}-${String(resilDate.getUTCMonth() + 1).padStart(2, '0')}`;
            if (!buckets[resilKey]) buckets[resilKey] = {};
            if (!buckets[resilKey][row.saison_id]) {
              buckets[resilKey][row.saison_id] = { revenus_cents: 0, adhesions_payees: 0, resiliations: 0 };
            }
            buckets[resilKey][row.saison_id].resiliations++;
          }
        }

        const MONTH_NAMES_FR = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

        const monthKeys = Object.keys(buckets).sort();
        if (monthKeys.length === 0) return res.json({ saisons: chosenSaisons, mode, periods: [] });

        const periods = monthKeys.map(key => {
          const [year, monthNum] = key.split('-').map(Number);
          const monthName = MONTH_NAMES_FR[monthNum - 1];
          return {
            label: `${monthName} ${year}`,
            month_key: key,
            data: chosenSaisons.map(s => {
              if (!s) return null;
              const d = (buckets[key] || {})[s.id] || { revenus_cents: 0, adhesions_payees: 0, resiliations: 0 };
              return { saison_id: s.id, saison_nom: s.nom, ...d };
            })
          };
        });

        return res.json({ saisons: chosenSaisons, mode, periods });
      }
    } catch (err) {
      console.error('[comparatif] GET /inter-saisons error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/comparatif/par-discipline?anchor_saison_id=<id>
  //
  // Returns per-discipline enrollment counts and projected revenues for 3 seasons
  // (n-2, n-1, n) relative to anchor_saison_id (defaults to active saison).
  //
  // Response shape:
  // {
  //   saisons: [{ id, nom } | null]   ← 3 items: index 0=n-2, 1=n-1, 2=n (null if missing)
  //   disciplines: [
  //     {
  //       nom: string,
  //       data: [
  //         { saison_id, saison_nom, eleves, revenus_cents } | null   ← index matches saisons[]
  //       ]
  //     }
  //   ]  ← ordered by enrollment count desc in saison n (anchor)
  // }
  router.get('/par-discipline', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      let anchorId = req.query.anchor_saison_id ? parseInt(req.query.anchor_saison_id) : null;

      // ── 1. Fetch all saisons ordered chronologically ─────────────────────────
      const saisonsRes = await pool.query(
        `SELECT id, nom, date_debut, active
         FROM saisons
         ORDER BY date_debut ASC NULLS LAST, id ASC`
      );
      const allSaisons = saisonsRes.rows;
      if (allSaisons.length === 0) return res.json({ saisons: [null, null, null], disciplines: [] });

      // Resolve anchor: default to active saison
      if (!anchorId) {
        const active = allSaisons.find(s => s.active);
        anchorId = active ? active.id : allSaisons[allSaisons.length - 1].id;
      }

      const anchorIdx = allSaisons.findIndex(s => s.id === anchorId);
      if (anchorIdx === -1) return res.status(400).json({ error: 'Saison introuvable' });

      // Pick up to 3 consecutive seasons ending at anchor
      const endIdx = anchorIdx;
      const startIdx = Math.max(0, endIdx - 2);
      const chosenSaisons = allSaisons.slice(startIdx, endIdx + 1);

      // Pad to length 3 with nulls at the beginning
      while (chosenSaisons.length < 3) {
        chosenSaisons.unshift(null);
      }

      const validSaisons = chosenSaisons.filter(Boolean);
      const validIds = validSaisons.map(s => s.id);

      if (validIds.length === 0) return res.json({ saisons: chosenSaisons, disciplines: [] });

      // ── 2. Per-discipline counts + projected revenues per saison ─────────────
      // Projected revenue = sum of formulas.montant_annuel_cents for enrolled students
      // (same revenue model as inter-saisons: annual formula price at time of inscription)
      const discRes = await pool.query(
        `SELECT
           sd_agg.saison_id,
           sd_agg.discipline_name,
           sd_agg.eleves,
           COALESCE(rev_agg.revenus_cents, 0) AS revenus_cents
         FROM (
           SELECT
             ss.saison_id,
             d.name AS discipline_name,
             COUNT(DISTINCT sd.student_id) AS eleves
           FROM student_disciplines sd
           JOIN disciplines d ON d.id = sd.discipline_id
           JOIN student_saisons ss ON ss.student_id = sd.student_id AND ss.saison_id = ANY($1::int[])
           JOIN students s ON s.id = sd.student_id AND s.active = true
           GROUP BY ss.saison_id, d.name
         ) sd_agg
         LEFT JOIN (
           SELECT
             ss2.saison_id,
             d2.name AS discipline_name,
             SUM(COALESCE(f.montant_annuel_cents, 0)) AS revenus_cents
           FROM student_disciplines sd2
           JOIN disciplines d2 ON d2.id = sd2.discipline_id
           JOIN student_saisons ss2 ON ss2.student_id = sd2.student_id AND ss2.saison_id = ANY($1::int[])
           JOIN students s2 ON s2.id = sd2.student_id AND s2.active = true
           LEFT JOIN formulas f ON f.id = ss2.formule_id
           WHERE ss2.adhesion_payee = true
           GROUP BY ss2.saison_id, d2.name
         ) rev_agg ON rev_agg.saison_id = sd_agg.saison_id AND rev_agg.discipline_name = sd_agg.discipline_name
         ORDER BY sd_agg.discipline_name`,
        [validIds]
      );

      // ── 3. Build per-discipline structure ────────────────────────────────────
      // Index by discipline name first, then by saison_id
      const byDisc = {}; // { disciplineName: { [saisonId]: { eleves, revenus_cents } } }
      for (const row of discRes.rows) {
        if (!byDisc[row.discipline_name]) byDisc[row.discipline_name] = {};
        byDisc[row.discipline_name][row.saison_id] = {
          eleves: parseInt(row.eleves, 10),
          revenus_cents: parseInt(row.revenus_cents, 10) || 0
        };
      }

      // Collect all discipline names — order by anchor saison enrollment desc
      const anchorSaison = chosenSaisons[2]; // index 2 = n
      const allDisciplineNames = Object.keys(byDisc).sort((a, b) => {
        const countA = anchorSaison ? ((byDisc[a][anchorSaison.id] || {}).eleves || 0) : 0;
        const countB = anchorSaison ? ((byDisc[b][anchorSaison.id] || {}).eleves || 0) : 0;
        return countB - countA; // desc
      });

      const disciplines = allDisciplineNames.map(nom => ({
        nom,
        data: chosenSaisons.map(s => {
          if (!s) return null;
          const d = byDisc[nom][s.id];
          if (!d) return null; // discipline not present in that saison
          return { saison_id: s.id, saison_nom: s.nom, eleves: d.eleves, revenus_cents: d.revenus_cents };
        })
      }));

      return res.json({
        saisons: chosenSaisons.map(s => s ? { id: s.id, nom: s.nom } : null),
        disciplines
      });

    } catch (err) {
      console.error('[comparatif] GET /par-discipline error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};
