// routes/classes.js
// Owns: class CRUD + /:id/students + /:id/passagers CRUD.
// Does NOT own: attendance records, schedule PDF, class PDF (those live in attendance.js and server.js).

module.exports = function createClassesRouter({ pool, requireAuth, logAudit }) {
  const express = require('express');
  const router = express.Router();

  // GET /api/classes — list all classes with discipline/location info
  router.get('/', async (req, res) => {
    try {
      const { location_id, discipline_id, day_of_week } = req.query;
      let query = `
        SELECT c.*,
          d.name as discipline_name, d.color as discipline_color,
          l.name as location_name, l.city as location_city,
          (SELECT COUNT(*) FROM attendance a
           WHERE a.class_id = c.id AND a.session_date = CURRENT_DATE AND a.status = 'present') as today_attendance,
          (SELECT COUNT(*) FROM student_disciplines sd
           JOIN students st ON st.id = sd.student_id
           WHERE sd.discipline_id = c.discipline_id AND st.active = true) as enrolled_count
        FROM classes c
        JOIN disciplines d ON c.discipline_id = d.id
        JOIN locations l ON c.location_id = l.id
        WHERE c.active = true
      `;
      const params = [];
      let paramIdx = 1;

      if (location_id) {
        query += ` AND c.location_id = $${paramIdx}`;
        params.push(location_id);
        paramIdx++;
      }
      if (discipline_id) {
        query += ` AND c.discipline_id = $${paramIdx}`;
        params.push(discipline_id);
        paramIdx++;
      }
      if (day_of_week !== undefined) {
        query += ` AND c.day_of_week = $${paramIdx}`;
        params.push(day_of_week);
        paramIdx++;
      }

      query += ' ORDER BY c.day_of_week, c.start_time';
      const result = await pool.query(query, params);
      res.json(result.rows);
    } catch (err) {
      console.error('Error fetching classes:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // POST /api/classes — create class
  router.post('/', async (req, res) => {
    try {
      const { discipline_id, location_id, teacher_name, day_of_week, start_time, end_time, level, max_students, secondary_label, practice_levels } = req.body;

      if (!discipline_id || !location_id || day_of_week === undefined || !start_time || !end_time) {
        return res.status(400).json({ error: 'Champs requis manquants' });
      }

      const result = await pool.query(
        `INSERT INTO classes (discipline_id, location_id, teacher_name, day_of_week, start_time, end_time, level, max_students, secondary_label, practice_levels)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [discipline_id, location_id, teacher_name || null, day_of_week, start_time, end_time, level || 'tous niveaux', max_students || 20, secondary_label || null, practice_levels || []]
      );

      const fullClass = await pool.query(
        `SELECT c.*, d.name as discipline_name, d.color as discipline_color, l.name as location_name, l.city as location_city
         FROM classes c JOIN disciplines d ON c.discipline_id = d.id JOIN locations l ON c.location_id = l.id
         WHERE c.id = $1`,
        [result.rows[0].id]
      );

      res.status(201).json(fullClass.rows[0]);
    } catch (err) {
      console.error('Error creating class:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // PUT /api/classes/:id — update class (requires auth, PRÉSIDENT/DIRECTRICE)
  router.put('/:id', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const { id } = req.params;
      const { discipline_id, location_id, teacher_name, day_of_week, start_time, end_time, level, max_students, secondary_label, practice_levels } = req.body;

      const result = await pool.query(
        `UPDATE classes SET
           discipline_id = COALESCE($1, discipline_id),
           location_id = COALESCE($2, location_id),
           teacher_name = $3,
           day_of_week = COALESCE($4, day_of_week),
           start_time = $5,
           end_time = $6,
           level = COALESCE($7, level),
           max_students = COALESCE($8, max_students),
           secondary_label = $9,
           practice_levels = COALESCE($10, practice_levels),
           updated_at = NOW()
         WHERE id = $11 RETURNING *`,
        [
          discipline_id || null, location_id || null,
          teacher_name !== undefined ? (teacher_name || null) : undefined,
          day_of_week !== undefined ? day_of_week : undefined,
          start_time || null, end_time || null,
          level || null, max_students || null,
          secondary_label !== undefined ? (secondary_label || null) : undefined,
          practice_levels !== undefined ? (Array.isArray(practice_levels) ? practice_levels : []) : undefined,
          id
        ]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cours non trouve' });
      }

      if (req.user) await logAudit(req.user.id, req.user.email, req.user.role, 'UPDATE_CLASS', 'classes', id,
        { teacher_name: result.rows[0].teacher_name }, req.ip);

      const fullClass = await pool.query(
        `SELECT c.*, d.name as discipline_name, d.color as discipline_color, l.name as location_name, l.city as location_city
         FROM classes c JOIN disciplines d ON c.discipline_id = d.id JOIN locations l ON c.location_id = l.id
         WHERE c.id = $1`,
        [id]
      );
      res.json(fullClass.rows[0]);
    } catch (err) {
      console.error('Error updating class:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // DELETE /api/classes/:id — soft delete (requires auth)
  router.delete('/:id', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query('UPDATE classes SET active = false WHERE id = $1 RETURNING id, teacher_name', [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cours non trouve' });
      }
      if (req.user) await logAudit(req.user.id, req.user.email, req.user.role, 'DELETE_CLASS', 'classes', id,
        { teacher_name: result.rows[0].teacher_name }, req.ip);
      res.json({ deleted: true });
    } catch (err) {
      console.error('Error deleting class:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // PATCH /api/classes/:id/restore — restore deleted class
  router.patch('/:id/restore', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const { id } = req.params;
      const result = await pool.query('UPDATE classes SET active = true WHERE id = $1 RETURNING id', [id]);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cours non trouve' });
      }
      res.json({ restored: true });
    } catch (err) {
      console.error('Error restoring class:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/classes/:id/students — enrolled students for a class (by discipline)
  router.get('/:id/students', async (req, res) => {
    try {
      const { id } = req.params;
      const classResult = await pool.query(
        'SELECT discipline_id, practice_levels FROM classes WHERE id = $1',
        [id]
      );
      if (classResult.rows.length === 0) {
        return res.status(404).json({ error: 'Cours non trouve' });
      }
      const { discipline_id: disciplineId, practice_levels: classPracticeLevels } = classResult.rows[0];
      const students = await pool.query(
        `SELECT s.id, s.first_name, s.last_name, s.practice_levels
         FROM students s
         JOIN student_disciplines sd ON s.id = sd.student_id
         WHERE sd.discipline_id = $1 AND s.active = true
         ORDER BY s.last_name, s.first_name`,
        [disciplineId]
      );
      res.json({ class_practice_levels: classPracticeLevels || [], students: students.rows });
    } catch (err) {
      console.error('Error fetching class students:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/classes/:id/passagers/:date
  router.get('/:id/passagers/:date', async (req, res) => {
    try {
      const { id, date } = req.params;
      const result = await pool.query(
        'SELECT count FROM class_passagers WHERE class_id = $1 AND session_date = $2',
        [id, date]
      );
      res.json({ count: result.rows.length > 0 ? result.rows[0].count : 0 });
    } catch (err) {
      console.error('Error fetching passagers:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // POST /api/classes/:id/passagers/:date
  router.post('/:id/passagers/:date', async (req, res) => {
    try {
      const { id, date } = req.params;
      const count = parseInt(req.body.count);
      if (isNaN(count) || count < 0) return res.status(400).json({ error: 'count doit être ≥ 0' });

      if (!req.isTablet) {
        const allowed = ['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR'];
        if (!req.user || !allowed.includes(req.user.role)) {
          return res.status(403).json({ error: 'Accès refusé' });
        }
      }

      const updatedBy = req.user ? req.user.id : null;
      const result = await pool.query(
        `INSERT INTO class_passagers (class_id, session_date, count, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (class_id, session_date) DO UPDATE
           SET count = $3, updated_by = $4, updated_at = NOW()
         RETURNING *`,
        [id, date, count, updatedBy]
      );
      res.json(result.rows[0]);
    } catch (err) {
      console.error('Error saving passagers:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};