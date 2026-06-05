// Archives — archived (soft-deleted) student management
// Owns: GET /api/archives/students, PATCH /:id/restore, DELETE /:id/purge
// Does NOT own: active student CRUD, class/formula soft delete

const express = require('express');
const router = express.Router();

module.exports = function createArchivesRouter({ pool, requireAuth, logAudit }) {

  // GET /api/archives/students — list all archived students
  router.get('/students', requireAuth(['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR']), async (req, res) => {
    try {
      const { search } = req.query;
      let query = `
        SELECT s.id, s.first_name, s.last_name, s.email, s.phone, s.level,
               s.numero_adherent, s.formule, s.archived_at,
               COALESCE(json_agg(
                 json_build_object('id', d.id, 'name', d.name, 'color', d.color)
               ) FILTER (WHERE d.id IS NOT NULL), '[]') AS disciplines
        FROM students s
        LEFT JOIN student_disciplines sd ON s.id = sd.student_id
        LEFT JOIN disciplines d ON sd.discipline_id = d.id
        WHERE s.active = false
      `;
      const params = [];
      if (search) {
        params.push(`%${search}%`);
        query += ` AND (LOWER(s.first_name) LIKE LOWER($1) OR LOWER(s.last_name) LIKE LOWER($1))`;
      }
      query += ' GROUP BY s.id ORDER BY s.archived_at DESC, s.last_name, s.first_name';
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error('[archives] GET /students error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // PATCH /api/archives/students/:id/restore — reactivate archived student
  router.patch('/students/:id/restore', requireAuth(['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR']), async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query(
        `UPDATE students SET active = true, archived_at = NULL WHERE id = $1 AND active = false RETURNING id, first_name, last_name`,
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Élève archivé introuvable' });
      }
      const s = result.rows[0];
      await logAudit(req.user.id, req.user.email, req.user.role, 'RESTORE_STUDENT', 'students', id,
        { name: `${s.first_name} ${s.last_name}` }, req.ip);
      res.json({ restored: true, student: s });
    } catch (err) {
      console.error('[archives] PATCH /students/:id/restore error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // DELETE /api/archives/students/:id/purge — permanent RGPD deletion (PRÉSIDENT only)
  router.delete('/students/:id/purge', requireAuth(['PRÉSIDENT']), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const check = await client.query(
        `SELECT id, first_name, last_name FROM students WHERE id = $1 AND active = false`,
        [req.params.id]
      );
      if (check.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Élève archivé introuvable (doit être archivé avant suppression définitive)' });
      }
      const s = check.rows[0];
      const name = `${s.first_name} ${s.last_name}`;

      // Remove all relational data first
      await client.query(`DELETE FROM attendance WHERE student_id = $1`, [s.id]);
      await client.query(`DELETE FROM student_disciplines WHERE student_id = $1`, [s.id]);
      await client.query(`DELETE FROM student_saisons WHERE student_id = $1`, [s.id]);
      await client.query(`DELETE FROM famille_beneficiaires WHERE beneficiaire_student_id = $1`, [s.id]);
      await client.query(`DELETE FROM famille_groupes WHERE titulaire_student_id = $1`, [s.id]);

      // Delete the student record
      await client.query(`DELETE FROM students WHERE id = $1`, [s.id]);

      await client.query('COMMIT');
      await logAudit(req.user.id, req.user.email, req.user.role, 'PURGE_STUDENT', 'students', String(s.id),
        { name }, req.ip);
      res.json({ purged: true, name });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[archives] DELETE /students/:id/purge error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  return router;
};
