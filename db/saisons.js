// db/saisons.js
// Owns: all queries against saisons, saison_formulas, and saison-scoped student_saisons.
// Does NOT own: global formulas CRUD (server.js), student CRUD, attendance.

/**
 * List all saisons ordered by most recent first.
 * Returns: [{ id, nom, date_debut, date_fin, active, statut, created_at }]
 */
async function listSaisons(pool) {
  const r = await pool.query(
    `SELECT id, nom, date_debut, date_fin, active, statut, created_at
     FROM saisons
     ORDER BY date_debut DESC NULLS LAST, nom DESC`
  );
  return r.rows;
}

/**
 * Get a single saison by id.
 */
async function getSaisonById(pool, id) {
  const r = await pool.query(
    `SELECT id, nom, date_debut, date_fin, active, statut, created_at
     FROM saisons WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

/**
 * Get the current active saison (statut='active', active=TRUE).
 */
async function getActiveSaison(pool) {
  const r = await pool.query(
    `SELECT id, nom, date_debut, date_fin, active, statut, created_at
     FROM saisons WHERE active = TRUE LIMIT 1`
  );
  return r.rows[0] || null;
}

/**
 * Get formulas for a specific saison from saison_formulas.
 * Falls back to global formulas if no saison_formulas exist for this saison.
 */
async function getSaisonFormulas(pool, saisonId) {
  const r = await pool.query(
    `SELECT id, label, position, active, prix_cents, periodicite, description, montant_annuel_cents
     FROM saison_formulas
     WHERE saison_id = $1 AND active = TRUE
     ORDER BY position, label`,
    [saisonId]
  );
  if (r.rows.length > 0) return r.rows;
  // Fallback to global formulas (pre-migration seasons or empty saison_formulas)
  const fallback = await pool.query(
    `SELECT id, label, position, active, prix_cents, periodicite, description, montant_annuel_cents
     FROM formulas WHERE active = TRUE ORDER BY position, label`
  );
  return fallback.rows;
}

/**
 * Create a new saison by cloning the source saison.
 * - Copies all active students (not archived) with their full profile
 * - Duplicates the source saison's formulas into saison_formulas
 * - Resets: adhesion_payee=false, versements_cents=0
 * - Preserves: formule_id (from source student_saison), cours_unite_count=0
 *
 * Returns the newly created saison row.
 */
async function createSaisonClone(pool, { nom, date_debut, date_fin, sourceSaisonId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deactivate current active saison
    await client.query(`UPDATE saisons SET active = FALSE WHERE active = TRUE`);

    // Insert new saison
    const ins = await client.query(
      `INSERT INTO saisons (nom, date_debut, date_fin, active, statut)
       VALUES ($1, $2, $3, TRUE, 'active')
       RETURNING id, nom, date_debut, date_fin, active, statut, created_at`,
      [nom, date_debut || null, date_fin || null]
    );
    const newSaison = ins.rows[0];

    // Clone saison_formulas from source saison (or global formulas if no saison_formulas)
    const sourceFormulas = await client.query(
      `SELECT label, position, active, prix_cents, periodicite, description, montant_annuel_cents
       FROM saison_formulas WHERE saison_id = $1`,
      [sourceSaisonId]
    );
    const formulas = sourceFormulas.rows.length > 0
      ? sourceFormulas.rows
      : (await client.query(
          `SELECT label, position, active, prix_cents, periodicite, description, montant_annuel_cents
           FROM formulas WHERE active = TRUE ORDER BY position`
        )).rows;

    for (const f of formulas) {
      await client.query(
        `INSERT INTO saison_formulas (saison_id, label, position, active, prix_cents, periodicite, description, montant_annuel_cents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (saison_id, label) DO NOTHING`,
        [newSaison.id, f.label, f.position, f.active, f.prix_cents, f.periodicite, f.description, f.montant_annuel_cents]
      );
    }

    // Clone students: all active (non-archived) students linked to the source saison
    // Reset: adhesion_payee=false, versements_cents=0, cours_unite_count=0, date_resiliation=null
    await client.query(
      `INSERT INTO student_saisons (student_id, saison_id, adhesion_payee, formule_id, versements_cents, cours_unite_count)
       SELECT
         ss.student_id,
         $1,
         FALSE,
         ss.formule_id,
         0,
         0
       FROM student_saisons ss
       JOIN students s ON s.id = ss.student_id
       WHERE ss.saison_id = $2
         AND s.archived_at IS NULL
       ON CONFLICT (student_id, saison_id) DO NOTHING`,
      [newSaison.id, sourceSaisonId]
    );

    await client.query('COMMIT');
    return newSaison;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Clôturer (close) a saison. Irreversible. Only PRÉSIDENT.
 * Sets statut='cloturee', active=FALSE.
 * If this was the active saison, the most recent non-cloturee saison becomes active.
 */
async function cloturerSaison(pool, saisonId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const check = await client.query(
      `SELECT id, active, statut FROM saisons WHERE id = $1`, [saisonId]
    );
    if (!check.rows[0]) throw new Error('Saison introuvable');
    if (check.rows[0].statut === 'cloturee') throw new Error('Saison déjà clôturée');

    const wasActive = check.rows[0].active;

    await client.query(
      `UPDATE saisons SET statut = 'cloturee', active = FALSE WHERE id = $1`,
      [saisonId]
    );

    // If we just deactivated the active saison, promote the most recent other one
    if (wasActive) {
      await client.query(
        `UPDATE saisons SET active = TRUE
         WHERE id = (
           SELECT id FROM saisons
           WHERE statut = 'active'
           ORDER BY date_debut DESC NULLS LAST, nom DESC
           LIMIT 1
         )`
      );
    }

    await client.query('COMMIT');

    const updated = await client.query(
      `SELECT id, nom, date_debut, date_fin, active, statut FROM saisons WHERE id = $1`,
      [saisonId]
    );
    return updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get saison_formulas for update — with inactive ones included (for settings management).
 */
async function getAllSaisonFormulas(pool, saisonId) {
  const r = await pool.query(
    `SELECT id, label, position, active, prix_cents, periodicite, description, montant_annuel_cents
     FROM saison_formulas WHERE saison_id = $1
     ORDER BY position, label`,
    [saisonId]
  );
  return r.rows;
}

module.exports = {
  listSaisons,
  getSaisonById,
  getActiveSaison,
  getSaisonFormulas,
  getAllSaisonFormulas,
  createSaisonClone,
  cloturerSaison,
};
