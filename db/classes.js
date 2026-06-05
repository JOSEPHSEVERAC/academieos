// db/classes.js
// Owns: update query for the classes table.
// Does NOT own: class creation/deletion (server.js), attendance, student enrollment.

/**
 * Update a class by id. Returns the updated row joined with discipline and location.
 * Returns null if the class does not exist or is inactive.
 *
 * @param {Pool} pool
 * @param {number|string} id
 * @param {{ discipline_id, location_id, teacher_name, day_of_week, start_time, end_time, max_students, secondary_label, practice_levels }} fields
 */
async function updateClass(pool, id, fields) {
  const { discipline_id, location_id, teacher_name, day_of_week, start_time, end_time, max_students, secondary_label, practice_levels } = fields;

  const result = await pool.query(
    `UPDATE classes
     SET discipline_id   = $1,
         location_id     = $2,
         teacher_name    = $3,
         day_of_week     = $4,
         start_time      = $5,
         end_time        = $6,
         max_students    = $7,
         secondary_label = $8,
         practice_levels = $9
     WHERE id = $10 AND active = true
     RETURNING id`,
    [
      discipline_id,
      location_id,
      teacher_name || null,
      day_of_week,
      start_time,
      end_time,
      max_students || 20,
      secondary_label || null,
      practice_levels || [],
      id,
    ]
  );

  if (!result.rows.length) return null;

  const full = await pool.query(
    `SELECT c.*,
       d.name  AS discipline_name,
       d.color AS discipline_color,
       l.name  AS location_name,
       l.city  AS location_city
     FROM classes c
     JOIN disciplines d ON c.discipline_id = d.id
     JOIN locations  l ON c.location_id  = l.id
     WHERE c.id = $1`,
    [id]
  );

  return full.rows[0] || null;
}

module.exports = { updateClass };
