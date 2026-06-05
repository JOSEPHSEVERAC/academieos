// db/attendance.js
// Owns: all write queries on formula_attendance.
// Does NOT own: class-level attendance (attendance table), formula/student master data.

/**
 * Upsert a formula attendance record.
 * Uses ON CONFLICT to support re-marking (student changes status on same day).
 * Returns the upserted row.
 */
async function upsertFormulaAttendance(pool, { student_id, formula_id, date, status, noted_by = null }) {
  const result = await pool.query(
    `INSERT INTO formula_attendance (student_id, formula_id, date, status, noted_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (student_id, formula_id, date) DO UPDATE
       SET status = EXCLUDED.status,
           noted_by = EXCLUDED.noted_by,
           created_at = NOW()
     RETURNING *`,
    [student_id, formula_id, date, status, noted_by]
  );
  return result.rows[0];
}

/**
 * Batch upsert multiple attendance entries in a transaction.
 * Returns all upserted rows.
 */
async function upsertFormulaAttendanceBatch(pool, entries) {
  if (!entries.length) return [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const { student_id, formula_id, date, status, noted_by } of entries) {
      const r = await client.query(
        `INSERT INTO formula_attendance (student_id, formula_id, date, status, noted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (student_id, formula_id, date) DO UPDATE
           SET status = EXCLUDED.status, noted_by = EXCLUDED.noted_by, created_at = NOW()
         RETURNING *`,
        [student_id, formula_id, date, status, noted_by ?? null]
      );
      results.push(r.rows[0]);
    }
    await client.query('COMMIT');
    return results;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get all students enrolled in a formula for the active saison,
 * with their attendance status on a given date (LEFT JOIN so unmarked students appear).
 * Returns: { students: [...], attendance_rates: { student_id: rate } }
 */
async function getFormulaAttendanceByDate(pool, formulaId, date) {
  const activeSaisonRes = await pool.query(
    `SELECT id FROM saisons WHERE active = TRUE LIMIT 1`
  );
  const saisonId = activeSaisonRes.rows[0]?.id;
  if (!saisonId) return [];

  // Students currently enrolled in this formula for active saison
  const studentsRes = await pool.query(
    `SELECT
       s.id,
       s.first_name,
       s.last_name,
       s.numero_adherent,
       fa.status
     FROM student_saisons ss
     JOIN students s ON s.id = ss.student_id
     LEFT JOIN formula_attendance fa
       ON fa.student_id = s.id
      AND fa.formula_id = $1
      AND fa.date = $2
     WHERE ss.saison_id = $3
       AND ss.formule_id = $1
       AND s.active = true
     ORDER BY s.last_name, s.first_name`,
    [formulaId, date, saisonId]
  );
  return studentsRes.rows;
}

/**
 * Get attendance history for a student over the last N days.
 * Returns: [{ date, status, formula_label }]
 * Also computes the attendance rate.
 */
async function getStudentAttendanceHistory(pool, studentId, days = 30) {
  const result = await pool.query(
    `SELECT
       fa.date,
       fa.status,
       f.label AS formula_label
     FROM formula_attendance fa
     JOIN formulas f ON f.id = fa.formula_id
     WHERE fa.student_id = $1
       AND fa.date >= CURRENT_DATE - INTERVAL '1 day' * $2
     ORDER BY fa.date DESC`,
    [studentId, days]
  );

  const present = result.rows.filter(r => r.status === 'present').length;
  const rate = result.rows.length > 0
    ? Math.round((present / result.rows.length) * 100)
    : null;

  return { history: result.rows, total: result.rows.length, rate };
}

/**
 * Get presence statistics for a student across 3 periods:
 * this week (Mon→today), this month (1st→today), this season (Sept→June).
 * Uses formula_attendance as the source.
 * Returns: { week, month, saison }
 */
async function getStudentPresenceStats(pool, studentId) {
  const saisonRes = await pool.query(
    `SELECT date_debut, date_fin FROM saisons WHERE active = TRUE LIMIT 1`
  );
  if (!saisonRes.rows.length) return { week: null, month: null, saison: null };
  const { date_debut, date_fin } = saisonRes.rows[0];

  const [weekStart, monthStart] = [new Date(), new Date()];
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1); // Monday
  monthStart.setDate(1);

  const query = `
    SELECT
      -- This week (Mon → today inclusive)
      (SELECT COUNT(*) FROM formula_attendance
       WHERE student_id = $1 AND date >= $2 AND date <= CURRENT_DATE AND status = 'present') as week_present,
      (SELECT COUNT(*) FROM formula_attendance
       WHERE student_id = $1 AND date >= $2 AND date <= CURRENT_DATE) as week_total,
      -- This month (1st → today inclusive)
      (SELECT COUNT(*) FROM formula_attendance
       WHERE student_id = $1 AND date >= $3 AND date <= CURRENT_DATE AND status = 'present') as month_present,
      (SELECT COUNT(*) FROM formula_attendance
       WHERE student_id = $1 AND date >= $3 AND date <= CURRENT_DATE) as month_total,
      -- This season (date_debut → date_fin)
      (SELECT COUNT(*) FROM formula_attendance
       WHERE student_id = $1 AND date >= $4 AND date <= $5 AND status = 'present') as saison_present,
      (SELECT COUNT(*) FROM formula_attendance
       WHERE student_id = $1 AND date >= $4 AND date <= $5) as saison_total
  `;
  const result = await pool.query(query, [studentId, weekStart.toISOString().slice(0,10), monthStart.toISOString().slice(0,10), date_debut, date_fin]);
  const r = result.rows[0];
  const pct = (p, t) => t > 0 ? Math.round((p / t) * 100) : null;
  return {
    week:   { present: parseInt(r.week_present,10), total: parseInt(r.week_total,10), rate: pct(r.week_present, r.week_total) },
    month:  { present: parseInt(r.month_present,10), total: parseInt(r.month_total,10), rate: pct(r.month_present, r.month_total) },
    saison: { present: parseInt(r.saison_present,10), total: parseInt(r.saison_total,10), rate: pct(r.saison_present, r.saison_total) },
  };
}

module.exports = {
  upsertFormulaAttendance,
  upsertFormulaAttendanceBatch,
  getFormulaAttendanceByDate,
  getStudentAttendanceHistory,
  getStudentPresenceStats,
};