// routes/famille.js
// Owns: famille_groupes CRUD, famille_beneficiaires linking, formule cascade on link/unlink.
// Does NOT own: student CRUD, formula master data (formulas table), auth sessions.
//
// Formule cascade rule:
//   Link bénéficiaire   → set student.formule = 'Illimité famille (bénéficiaire)' + upsert student_saisons
//   Unlink bénéficiaire → clear formule if it was 'Illimité famille (bénéficiaire)'
//   Cascade fires inside the same DB transaction as the groupe update.

const express = require('express');

const FORMULE_BENEFICIAIRE = 'Illimité famille (bénéficiaire)';

// Upsert student.formule + student_saisons.formule_id in one call.
async function setStudentFormule(client, studentId, formuleLabel) {
  // Update denormalized column on students
  await client.query(
    `UPDATE students SET formule = $1, updated_at = NOW() WHERE id = $2`,
    [formuleLabel, studentId]
  );
  // Upsert student_saisons for the active season
  const saisonRes = await client.query('SELECT id FROM saisons WHERE active = TRUE LIMIT 1');
  if (saisonRes.rows.length === 0) return;
  const saisonId = saisonRes.rows[0].id;
  let formuleId = null;
  if (formuleLabel) {
    const fRes = await client.query('SELECT id FROM formulas WHERE label = $1', [formuleLabel]);
    if (fRes.rows.length > 0) formuleId = fRes.rows[0].id;
  }
  await client.query(
    `INSERT INTO student_saisons (student_id, saison_id, adhesion_payee, formule_id)
     VALUES ($1, $2, false, $3)
     ON CONFLICT (student_id, saison_id) DO UPDATE
       SET formule_id = COALESCE($3, student_saisons.formule_id)`,
    [studentId, saisonId, formuleId]
  );
}

// Clear formule only if it currently matches 'Illimité famille (bénéficiaire)'.
// Avoids clobbering a formule that was already changed to something else.
async function clearBeneficiaireFormule(client, studentId) {
  const cur = await client.query('SELECT formule FROM students WHERE id = $1', [studentId]);
  if (!cur.rows.length) return;
  if (cur.rows[0].formule !== FORMULE_BENEFICIAIRE) return; // already changed — don't touch

  await client.query(
    `UPDATE students SET formule = NULL, updated_at = NOW() WHERE id = $1`,
    [studentId]
  );
  // Clear formule_id in student_saisons as well
  const saisonRes = await client.query('SELECT id FROM saisons WHERE active = TRUE LIMIT 1');
  if (saisonRes.rows.length === 0) return;
  const saisonId = saisonRes.rows[0].id;
  await client.query(
    `UPDATE student_saisons SET formule_id = NULL
     WHERE student_id = $1 AND saison_id = $2`,
    [studentId, saisonId]
  );
}

module.exports = function createFamilleRouter({ pool, requireAuth }) {
  const router = express.Router();

  // ── GET / — list all famille groupes ──────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          fg.id,
          fg.titulaire_student_id,
          (s.last_name || ' ' || s.first_name) AS titulaire_name,
          COALESCE(
            json_agg(
              json_build_object('id', b.id, 'name', (bs.last_name || ' ' || bs.first_name))
            ) FILTER (WHERE b.id IS NOT NULL), '[]'
          ) AS beneficiaires
        FROM famille_groupes fg
        JOIN students s ON s.id = fg.titulaire_student_id
        LEFT JOIN famille_beneficiaires b ON b.groupe_id = fg.id
        LEFT JOIN students bs ON bs.id = b.beneficiaire_student_id
        GROUP BY fg.id, s.last_name, s.first_name
        ORDER BY s.last_name, s.first_name
      `);
      res.json(result.rows);
    } catch (err) {
      console.error('[famille] GET / error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /available-beneficiaires ──────────────────────────────────────────
  // Only shows students eligible as bénéficiaire:
  // - no formule (NULL or empty), OR already "Illimité famille (bénéficiaire)"
  // Excludes students with any other active formule, and the titulaire themselves.
  router.get('/available-beneficiaires', async (req, res) => {
    try {
      const { exclude_titulaire_id } = req.query;
      const params = [];
      let excludeClause = '';
      if (exclude_titulaire_id) {
        params.push(exclude_titulaire_id);
        excludeClause = `AND s.id != $${params.length}`;
      }
      const query = `
        SELECT s.id, s.first_name, s.last_name, s.formule
        FROM students s
        WHERE s.active = true
          AND s.id NOT IN (SELECT titulaire_student_id FROM famille_groupes)
          AND (s.formule IS NULL OR s.formule = '' OR s.formule = 'Illimité famille (bénéficiaire)')
          ${excludeClause}
        ORDER BY s.last_name, s.first_name
      `;
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error('[famille] GET /available-beneficiaires error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /available-titulaires ──────────────────────────────────────────────
  router.get('/available-titulaires', async (req, res) => {
    try {
      const { exclude_beneficiaire_id } = req.query;
      const params = [];
      let excludeClause = '';
      if (exclude_beneficiaire_id) {
        params.push(exclude_beneficiaire_id);
        excludeClause = `AND fb_count.beneficiaire_student_id != $${params.length}`;
      }
      // Students with Illimité famille formule that have < 2 bénéficiaires
      // (excluding the student being edited from capacity count)
      const result = await pool.query(`
        SELECT
          s.id,
          s.first_name,
          s.last_name,
          fg.id AS groupe_id,
          (
            SELECT COUNT(*) FROM famille_beneficiaires fb2
            WHERE fb2.groupe_id = fg.id
              ${exclude_beneficiaire_id ? `AND fb2.beneficiaire_student_id != $1` : ''}
          ) AS beneficiaire_count
        FROM students s
        LEFT JOIN famille_groupes fg ON fg.titulaire_student_id = s.id
        WHERE s.active = true
          AND s.formule = 'Illimité famille'
          AND (
            fg.id IS NULL
            OR (
              SELECT COUNT(*) FROM famille_beneficiaires fb3
              WHERE fb3.groupe_id = fg.id
                ${exclude_beneficiaire_id ? `AND fb3.beneficiaire_student_id != $1` : ''}
            ) < 2
          )
        ORDER BY s.last_name, s.first_name
      `, params);
      res.json(result.rows);
    } catch (err) {
      console.error('[famille] GET /available-titulaires error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /link-beneficiaire — link a bénéficiaire, cascade formule ─────────
  router.post('/link-beneficiaire', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { titulaire_student_id, beneficiaire_student_id } = req.body;
      if (!titulaire_student_id || !beneficiaire_student_id) {
        return res.status(400).json({ error: 'titulaire_student_id et beneficiaire_student_id requis' });
      }

      // Get or create the titulaire's groupe
      const groupRes = await client.query(
        'SELECT id FROM famille_groupes WHERE titulaire_student_id = $1',
        [titulaire_student_id]
      );
      let groupId;
      if (groupRes.rows.length === 0) {
        const newGroup = await client.query(
          'INSERT INTO famille_groupes (titulaire_student_id) VALUES ($1) RETURNING id',
          [titulaire_student_id]
        );
        groupId = newGroup.rows[0].id;
      } else {
        groupId = groupRes.rows[0].id;
      }

      // Enforce max 2 bénéficiaires
      const countRes = await client.query(
        'SELECT COUNT(*) AS cnt FROM famille_beneficiaires WHERE groupe_id = $1',
        [groupId]
      );
      if (parseInt(countRes.rows[0].cnt) >= 2) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Ce groupe a déjà 2 bénéficiaires (maximum atteint)' });
      }

      // Remove from any existing group first (unlink cascade for old group)
      const prevGroup = await client.query(
        'SELECT groupe_id FROM famille_beneficiaires WHERE beneficiaire_student_id = $1',
        [beneficiaire_student_id]
      );
      await client.query(
        'DELETE FROM famille_beneficiaires WHERE beneficiaire_student_id = $1',
        [beneficiaire_student_id]
      );

      // Link to new group
      await client.query(
        'INSERT INTO famille_beneficiaires (groupe_id, beneficiaire_student_id) VALUES ($1, $2)',
        [groupId, beneficiaire_student_id]
      );

      // Cascade: set bénéficiaire formule
      await setStudentFormule(client, beneficiaire_student_id, FORMULE_BENEFICIAIRE);

      await client.query('COMMIT');
      res.status(201).json({ groupe_id: groupId });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Ce bénéficiaire est déjà dans un groupe' });
      console.error('[famille] POST /link-beneficiaire error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  // ── POST / — create groupe + beneficiaires, cascade formule ───────────────
  router.post('/', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { titulaire_student_id, beneficiaire_ids } = req.body;
      if (!titulaire_student_id) return res.status(400).json({ error: 'titulaire_student_id requis' });

      // Titulaire must not already be a bénéficiaire
      const check = await client.query(
        'SELECT id FROM famille_beneficiaires WHERE beneficiaire_student_id = $1',
        [titulaire_student_id]
      );
      if (check.rows.length > 0) {
        return res.status(409).json({ error: "Cet élève est déjà bénéficiaire d'un autre groupe" });
      }

      // Create or get groupe
      const groupResult = await client.query(
        `INSERT INTO famille_groupes (titulaire_student_id) VALUES ($1)
         ON CONFLICT (titulaire_student_id) DO UPDATE SET titulaire_student_id = EXCLUDED.titulaire_student_id
         RETURNING id`,
        [titulaire_student_id]
      );
      const groupId = groupResult.rows[0].id;

      // Fetch previous bénéficiaires so we can clear their formule if removed
      const prevBens = await client.query(
        'SELECT beneficiaire_student_id FROM famille_beneficiaires WHERE groupe_id = $1',
        [groupId]
      );
      const prevBenIds = prevBens.rows.map(r => r.beneficiaire_student_id);

      // Replace beneficiaires
      await client.query('DELETE FROM famille_beneficiaires WHERE groupe_id = $1', [groupId]);
      const bIds = (beneficiaire_ids || []).slice(0, 2);
      for (const bid of bIds) {
        if (bid === titulaire_student_id) continue;
        await client.query(
          'INSERT INTO famille_beneficiaires (groupe_id, beneficiaire_student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [groupId, bid]
        );
      }

      // Cascade: set formule for newly added bénéficiaires
      for (const bid of bIds) {
        if (bid === titulaire_student_id) continue;
        await setStudentFormule(client, bid, FORMULE_BENEFICIAIRE);
      }

      // Cascade: clear formule for removed bénéficiaires
      for (const prevBid of prevBenIds) {
        if (!bIds.includes(prevBid)) {
          await clearBeneficiaireFormule(client, prevBid);
        }
      }

      await client.query('COMMIT');
      res.status(201).json({ groupe_id: groupId });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Ce groupe ou bénéficiaire existe déjà' });
      console.error('[famille] POST / error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  // ── PUT /:id — update beneficiaires of a group, cascade formule ───────────
  router.put('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { id } = req.params;
      const { beneficiaire_ids } = req.body;

      const group = await client.query(
        'SELECT titulaire_student_id FROM famille_groupes WHERE id = $1',
        [id]
      );
      if (group.rows.length === 0) return res.status(404).json({ error: 'Groupe non trouvé' });
      const titulaire_id = group.rows[0].titulaire_student_id;

      // Fetch previous bénéficiaires for cascade-clear
      const prevBens = await client.query(
        'SELECT beneficiaire_student_id FROM famille_beneficiaires WHERE groupe_id = $1',
        [id]
      );
      const prevBenIds = prevBens.rows.map(r => r.beneficiaire_student_id);

      await client.query('DELETE FROM famille_beneficiaires WHERE groupe_id = $1', [id]);
      const bIds = (beneficiaire_ids || []).slice(0, 2);
      for (const bid of bIds) {
        if (bid === titulaire_id) continue;
        await client.query(
          'INSERT INTO famille_beneficiaires (groupe_id, beneficiaire_student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [id, bid]
        );
      }

      // Cascade: set formule for newly added (or re-added) bénéficiaires
      for (const bid of bIds) {
        if (bid === titulaire_id) continue;
        await setStudentFormule(client, bid, FORMULE_BENEFICIAIRE);
      }

      // Cascade: clear formule for removed bénéficiaires
      for (const prevBid of prevBenIds) {
        if (!bIds.includes(prevBid)) {
          await clearBeneficiaireFormule(client, prevBid);
        }
      }

      await client.query('COMMIT');
      res.json({ updated: true });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Un bénéficiaire est déjà dans un autre groupe' });
      console.error('[famille] PUT /:id error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  // ── DELETE /:id — remove a groupe (cascades to bénéficiaires, clear formule) ─
  router.delete('/:id', async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { id } = req.params;

      // Fetch bénéficiaires before delete for formule cascade
      const bens = await client.query(
        'SELECT beneficiaire_student_id FROM famille_beneficiaires WHERE groupe_id = $1',
        [id]
      );
      const benIds = bens.rows.map(r => r.beneficiaire_student_id);

      const result = await client.query(
        'DELETE FROM famille_groupes WHERE id = $1 RETURNING id',
        [id]
      );
      if (result.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Groupe non trouvé' });
      }

      // Cascade: clear formule for all bénéficiaires of the deleted group
      for (const bid of benIds) {
        await clearBeneficiaireFormule(client, bid);
      }

      await client.query('COMMIT');
      res.json({ deleted: true });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[famille] DELETE /:id error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  return router;
};
