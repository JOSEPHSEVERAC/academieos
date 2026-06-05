// routes/saisons.js
// Owns: multi-saison management — list, create (clone), clôturer, saison_formulas CRUD.
// Does NOT own: global formulas (server.js), student CRUD, attendance, billing.

const express = require('express');
const {
  listSaisons,
  getSaisonById,
  getActiveSaison,
  getSaisonFormulas,
  getAllSaisonFormulas,
  createSaisonClone,
  cloturerSaison,
} = require('../db/saisons');

module.exports = function createSaisonsRouter({ pool, requireAuth, logAudit }) {
  const router = express.Router();

  // ──────────────────────────────────────────────────────────────────
  // GET /api/saisons — list all (public read, no auth required here;
  //   the blanket /api middleware enforces auth unless PUBLIC_API_PATHS
  //   includes /saisons — which it does in server.js)
  // ──────────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const rows = await listSaisons(pool);
      res.json(rows);
    } catch (err) {
      console.error('[saisons] GET / error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/saisons/active — current active saison (public read)
  // ──────────────────────────────────────────────────────────────────
  router.get('/active', async (req, res) => {
    try {
      const saison = await getActiveSaison(pool);
      res.json(saison || null);
    } catch (err) {
      console.error('[saisons] GET /active error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/saisons/:id — single saison (needs auth)
  // ──────────────────────────────────────────────────────────────────
  router.get('/:id', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const saison = await getSaisonById(pool, req.params.id);
      if (!saison) return res.status(404).json({ error: 'Saison introuvable' });
      res.json(saison);
    } catch (err) {
      console.error('[saisons] GET /:id error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /api/saisons — create new saison (clone from latest)
  // PRÉSIDENT + DIRECTRICE
  // Body: { nom, date_debut, date_fin, source_saison_id? }
  // ──────────────────────────────────────────────────────────────────
  router.post('/', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const { nom, date_debut, date_fin, source_saison_id } = req.body;
      if (!nom || !nom.trim()) return res.status(400).json({ error: 'Nom de saison requis' });
      const trimmedNom = nom.trim();

      // Determine source saison for clone (explicit or latest)
      let sourceSaisonId = source_saison_id;
      if (!sourceSaisonId) {
        const active = await getActiveSaison(pool);
        if (active) sourceSaisonId = active.id;
      }
      if (!sourceSaisonId) {
        return res.status(400).json({ error: 'Aucune saison source trouvée pour cloner' });
      }

      const newSaison = await createSaisonClone(pool, {
        nom: trimmedNom,
        date_debut: date_debut || null,
        date_fin: date_fin || null,
        sourceSaisonId,
      });

      await logAudit(
        req.user.id, req.user.email, req.user.role,
        'CREATE_SAISON', 'saisons', newSaison.id,
        { nom: trimmedNom, source_saison_id: sourceSaisonId },
        req.ip
      );

      res.status(201).json(newSaison);
    } catch (err) {
      console.error('[saisons] POST / error:', err);
      if (err.code === '23505') return res.status(409).json({ error: 'Une saison avec ce nom existe déjà' });
      res.status(500).json({ error: err.message || 'Erreur serveur' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /api/saisons/:id/cloturer — close a saison (PRÉSIDENT only, irreversible)
  // ──────────────────────────────────────────────────────────────────
  router.post('/:id/cloturer', requireAuth(['PRÉSIDENT']), async (req, res) => {
    try {
      const { id } = req.params;
      const updated = await cloturerSaison(pool, id);

      await logAudit(
        req.user.id, req.user.email, req.user.role,
        'CLOTURE_SAISON', 'saisons', id,
        { nom: updated.nom },
        req.ip
      );

      res.json(updated);
    } catch (err) {
      console.error('[saisons] POST /:id/cloturer error:', err);
      if (err.message === 'Saison introuvable') return res.status(404).json({ error: err.message });
      if (err.message === 'Saison déjà clôturée') return res.status(409).json({ error: err.message });
      res.status(500).json({ error: err.message || 'Erreur serveur' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // GET /api/saisons/:id/formulas — list formulas for a saison
  // ──────────────────────────────────────────────────────────────────
  router.get('/:id/formulas', requireAuth(['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR']), async (req, res) => {
    try {
      const rows = await getSaisonFormulas(pool, req.params.id);
      res.json(rows);
    } catch (err) {
      console.error('[saisons] GET /:id/formulas error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // POST /api/saisons/:id/formulas — add formula to a saison
  // Body: { label }
  // ──────────────────────────────────────────────────────────────────
  router.post('/:id/formulas', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const saisonId = req.params.id;

      // Block modifications on clôturée saisons
      const saison = await getSaisonById(pool, saisonId);
      if (!saison) return res.status(404).json({ error: 'Saison introuvable' });
      if (saison.statut === 'cloturee') return res.status(403).json({ error: 'Saison clôturée — lecture seule' });

      const { label } = req.body;
      if (!label || !label.trim()) return res.status(400).json({ error: 'Libellé requis' });

      const posR = await pool.query(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next FROM saison_formulas WHERE saison_id = $1`,
        [saisonId]
      );
      const position = posR.rows[0].next;

      const ins = await pool.query(
        `INSERT INTO saison_formulas (saison_id, label, position)
         VALUES ($1, $2, $3) RETURNING *`,
        [saisonId, label.trim(), position]
      );
      res.status(201).json(ins.rows[0]);
    } catch (err) {
      console.error('[saisons] POST /:id/formulas error:', err);
      if (err.code === '23505') return res.status(409).json({ error: 'Cette formule existe déjà dans cette saison' });
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // DELETE /api/saisons/:id/formulas/:fid — deactivate formula for a saison
  // ──────────────────────────────────────────────────────────────────
  router.delete('/:id/formulas/:fid', requireAuth(['PRÉSIDENT']), async (req, res) => {
    try {
      const { id: saisonId, fid } = req.params;

      const saison = await getSaisonById(pool, saisonId);
      if (!saison) return res.status(404).json({ error: 'Saison introuvable' });
      if (saison.statut === 'cloturee') return res.status(403).json({ error: 'Saison clôturée — lecture seule' });

      const r = await pool.query(
        `UPDATE saison_formulas SET active = FALSE
         WHERE id = $1 AND saison_id = $2 RETURNING id, label`,
        [fid, saisonId]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'Formule introuvable' });
      res.json({ ok: true, id: r.rows[0].id, label: r.rows[0].label });
    } catch (err) {
      console.error('[saisons] DELETE /:id/formulas/:fid error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};
