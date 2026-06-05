// db/formulas.js
// Owns: all read queries against the formulas table.
// Does NOT own: formula CRUD (server.js), student enrollment, billing.

/**
 * Fetch all active formulas ordered by position.
 * Returns: [{ id, label, position, prix_cents, periodicite, description, montant_annuel_cents }]
 */
async function getActiveFormulas(pool) {
  const result = await pool.query(
    `SELECT id, label, position, prix_cents, periodicite, description, montant_annuel_cents
     FROM formulas
     WHERE active = true
     ORDER BY position, label`
  );
  return result.rows;
}

/**
 * Fetch the currently active saison label (e.g. "2025/2026").
 * Returns: string | null
 */
async function getActiveSaisonLabel(pool) {
  const result = await pool.query(
    `SELECT nom FROM saisons WHERE active = true LIMIT 1`
  );
  return result.rows.length > 0 ? result.rows[0].nom : null;
}

module.exports = { getActiveFormulas, getActiveSaisonLabel };
