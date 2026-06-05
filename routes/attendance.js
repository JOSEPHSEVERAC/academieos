// routes/attendance.js
// Owns: class-based attendance (original) + formula-based attendance (new).
// Class-based routes: GET /:classId/:date, POST /, POST /bulk, POST /remove (no auth).
// Formula-based routes: GET /formula/:formulaId/:date, POST /formula (upsert batch),
//   GET /formula/student/:studentId (history + rate).
// Does NOT own: formula/student master data, class definitions.

const express = require('express');
const at = require('../db/attendance');

module.exports = function createAttendanceRouter({ pool, requireAuth }) {

  const router = express.Router();

  // ── Class-based (existing — no auth) ────────────────────────────────────────

  function isSessionLocked(sessionDate, startTime) {
    if (!sessionDate || !startTime) return false;
    const [h, m] = String(startTime).split(':').map(Number);
    const classStart = new Date(`${sessionDate}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`);
    return Date.now() >= classStart.getTime() + 24 * 60 * 60 * 1000;
  }

  router.get('/:classId/:date', async (req, res) => {
    try {
      const { classId, date } = req.params;
      // Guard: "presence" would match here first since route is defined before /presence/:studentId.
      // Reject non-numeric classIds → 404 so the presence route can handle them.
      if (isNaN(parseInt(classId, 10))) {
        return res.status(404).json({ error: 'Route non trouvée' });
      }
      const result = await pool.query(
        `SELECT a.*, s.first_name, s.last_name
         FROM attendance a
         JOIN students s ON a.student_id = s.id
         WHERE a.class_id = $1 AND a.session_date = $2
         ORDER BY s.last_name, s.first_name`,
        [classId, date]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching attendance:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  router.post('/', async (req, res) => {
    try {
      const { class_id, student_id, session_date, status } = req.body;
      if (!class_id || !student_id || !session_date || !status) {
        return res.status(400).json({ error: 'Champs requis manquants' });
      }
      const cls = await pool.query('SELECT start_time FROM classes WHERE id = $1', [class_id]);
      if (cls.rows.length && isSessionLocked(session_date, cls.rows[0].start_time)) {
        return res.status(403).json({ error: 'Fiche verrouillée — délai de 24h dépassé' });
      }
      const result = await pool.query(
        `INSERT INTO attendance (class_id, student_id, session_date, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (class_id, student_id, session_date)
         DO UPDATE SET status = $4, created_at = NOW()
         RETURNING *`,
        [class_id, student_id, session_date, status]
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error recording attendance:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  router.post('/bulk', async (req, res) => {
    const client = await pool.connect();
    try {
      const { class_id, session_date, records } = req.body;
      if (!class_id || !session_date || !records || !records.length) {
        return res.status(400).json({ error: 'Champs requis manquants' });
      }
      const clsCheck = await pool.query('SELECT start_time FROM classes WHERE id = $1', [class_id]);
      if (clsCheck.rows.length && isSessionLocked(session_date, clsCheck.rows[0].start_time)) {
        client.release();
        return res.status(403).json({ error: 'Fiche verrouillée — délai de 24h dépassé' });
      }
      await client.query('BEGIN');
      const results = [];
      for (const record of records) {
        const result = await client.query(
          `INSERT INTO attendance (class_id, student_id, session_date, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (class_id, student_id, session_date)
           DO UPDATE SET status = $4
           RETURNING *`,
          [class_id, record.student_id, session_date, record.status]
        );
        results.push(result.rows[0]);
      }
      await client.query('COMMIT');
      res.json(results);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Error recording bulk attendance:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  router.post('/remove', async (req, res) => {
    try {
      const { class_id, student_id, session_date } = req.body;
      if (!class_id || !student_id || !session_date) {
        return res.status(400).json({ error: 'Champs requis manquants' });
      }
      const clsCheck = await pool.query('SELECT start_time FROM classes WHERE id = $1', [class_id]);
      if (clsCheck.rows.length && isSessionLocked(session_date, clsCheck.rows[0].start_time)) {
        return res.status(403).json({ error: 'Fiche verrouillée — délai de 24h dépassé' });
      }
      await pool.query(
        `DELETE FROM attendance
         WHERE class_id = $1 AND student_id = $2 AND session_date = $3`,
        [class_id, student_id, session_date]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('Error removing attendance:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── Formula-based (new — auth required) ───────────────────────────────────────

  // GET /api/attendance/formula/:formulaId/:date
  // Students enrolled in formula on active saison, with today's status (LEFT JOIN).
  // Rôles: PRÉSIDENT, DIRECTRICE, PROFESSEUR.
  router.get('/formula/:formulaId/:date', requireAuth(['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR']), async (req, res) => {
    try {
      const { formulaId, date } = req.params;
      const rows = await at.getFormulaAttendanceByDate(pool, parseInt(formulaId, 10), date);
      res.json(rows);
    } catch (err) {
      console.error('[attendance] GET /formula/:formulaId/:date error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // POST /api/attendance/formula
  // Body: { entries: [{ student_id, formula_id, date, status }] }
  // Upsert via INSERT ... ON CONFLICT DO UPDATE.
  // Rôles: PRÉSIDENT, DIRECTRICE, PROFESSEUR.
  router.post('/formula', requireAuth(['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR']), async (req, res) => {
    try {
      const { entries } = req.body;
      if (!entries || !Array.isArray(entries) || !entries.length) {
        return res.status(400).json({ error: 'Champ "entries" requis — tableau non vide' });
      }
      for (const e of entries) {
        if (!e.student_id || !e.formula_id || !e.date || !e.status) {
          return res.status(400).json({ error: 'Chaque entrée doit avoir student_id, formula_id, date, status' });
        }
        if (!['present', 'absent', 'excused'].includes(e.status)) {
          return res.status(400).json({ error: `Statut invalide: ${e.status}` });
        }
      }
      const noted_by = req.user?.id ?? null;
      const results = await at.upsertFormulaAttendanceBatch(pool,
        entries.map(e => ({ ...e, noted_by }))
      );
      res.json({ success: true, count: results.length, results });
    } catch (err) {
      console.error('[attendance] POST /formula error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/attendance/formula/student/:studentId
  // History for last 30 days with attendance rate.
  // Rôles: PRÉSIDENT, DIRECTRICE.
  router.get('/formula/student/:studentId', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const { studentId } = req.params;
      const result = await at.getStudentAttendanceHistory(pool, parseInt(studentId, 10), 30);
      res.json(result);
    } catch (err) {
      console.error('[attendance] GET /formula/student/:studentId error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/attendance/presence/:studentId
  // Presence stats for 3 periods: week / month / season.
  // Rôles: PRÉSIDENT, DIRECTRICE.
  router.get('/presence/:studentId', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const { studentId } = req.params;
      const result = await at.getStudentPresenceStats(pool, parseInt(studentId, 10));
      res.json(result);
    } catch (err) {
      console.error('[attendance] GET /presence/:studentId error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};