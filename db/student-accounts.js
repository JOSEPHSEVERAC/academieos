// db/student-accounts.js
// Owns: read/write queries for student_accounts, student auth tokens, block status.
// Does NOT own: messages, posts, course groups, CRM user data.

/**
 * Get student account by id.
 */
async function getStudentAccountById(pool, id) {
  const result = await pool.query(
    `SELECT sa.id, sa.student_id, sa.email, sa.is_active, sa.created_at,
            s.first_name, s.last_name, s.sexe
     FROM student_accounts sa
     JOIN students s ON s.id = sa.student_id
     WHERE sa.id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Get student account by email.
 */
async function getStudentAccountByEmail(pool, email) {
  const result = await pool.query(
    `SELECT sa.id, sa.student_id, sa.email, sa.password_hash, sa.is_active,
            s.first_name, s.last_name
     FROM student_accounts sa
     JOIN students s ON s.id = sa.student_id
     WHERE sa.email = $1`,
    [email.toLowerCase().trim()]
  );
  return result.rows[0] || null;
}

/**
 * Check if a student account is currently blocked.
 */
async function isBlocked(pool, studentAccountId) {
  const result = await pool.query(
    `SELECT id FROM student_blocks
     WHERE student_account_id = $1 AND unblocked_at IS NULL
     LIMIT 1`,
    [studentAccountId]
  );
  return result.rows.length > 0;
}

/**
 * Create a student session token (7-day expiry).
 * Returns the raw token (caller sends to client).
 */
async function createStudentSession(pool, studentAccountId) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO auth_tokens (user_id, type, token_hash, expires_at)
     VALUES ($1, 'student_session', $2, $3)`,
    [studentAccountId, hash, expires]
  );
  return token;
}

/**
 * Validate a student session token. Returns student account row or null.
 */
async function validateStudentSession(pool, token) {
  if (!token) return null;
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(
    `SELECT sa.id, sa.student_id, sa.email, sa.is_active,
            s.first_name, s.last_name, s.sexe
     FROM auth_tokens t
     JOIN student_accounts sa ON sa.id = t.user_id
     JOIN students s ON s.id = sa.student_id
     WHERE t.token_hash = $1 AND t.type = 'student_session'
       AND t.used = false AND t.expires_at > NOW()
       AND sa.is_active = true`,
    [hash]
  );
  return result.rows[0] || null;
}

/**
 * Invalidate a student session.
 */
async function invalidateStudentSession(pool, token) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `UPDATE auth_tokens SET used = true WHERE token_hash = $1 AND type = 'student_session'`,
    [hash]
  );
}

/**
 * Create a temporary password token (one-time use, for CRM-generated temp passwords).
 */
async function createTempPasswordToken(pool, studentAccountId, tempPasswordHash) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const codeHash = crypto.createHash('sha256').update(tempPasswordHash).digest('hex');
  const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

  await pool.query(
    `INSERT INTO auth_tokens (user_id, type, token_hash, code_hash, expires_at)
     VALUES ($1, 'student_temp_pwd', $2, $3, $4)`,
    [studentAccountId, hash, codeHash, expires]
  );
  return token;
}

/**
 * Validate a student temp password token. Returns student account id or null.
 */
async function validateStudentTempToken(pool, token, password) {
  if (!token || !password) return null;
  const crypto = require('crypto');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const pwdHash = crypto.createHash('sha256').update(password).digest('hex');

  const result = await pool.query(
    `SELECT sa.id, sa.student_id, sa.email, sa.is_active,
            s.first_name, s.last_name, s.sexe
     FROM auth_tokens t
     JOIN student_accounts sa ON sa.id = t.user_id
     JOIN students s ON s.id = sa.student_id
     WHERE t.token_hash = $1 AND t.type = 'student_temp_pwd'
       AND t.code_hash = $2 AND t.used = false AND t.expires_at > NOW()
       AND sa.is_active = true`,
    [tokenHash, pwdHash]
  );
  return result.rows[0] || null;
}

module.exports = {
  getStudentAccountById,
  getStudentAccountByEmail,
  isBlocked,
  createStudentSession,
  validateStudentSession,
  invalidateStudentSession,
  createTempPasswordToken,
  validateStudentTempToken,
};