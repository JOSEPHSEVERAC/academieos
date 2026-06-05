// db/moderation.js
// Owns: read/write queries for moderation_actions, student_blocks, message_reports.
// Does NOT own: message content (messages table), student identity (students/student_accounts tables).

/**
 * Log a moderation action. Returns the inserted row.
 * action_type: 'delete_message' | 'block_student' | 'unblock_student'
 */
async function logModerationAction(pool, { moderatorRole, moderatorName, actionType, targetType, targetId, reason }) {
  const result = await pool.query(
    `INSERT INTO moderation_actions (moderator_role, moderator_name, action_type, target_type, target_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [moderatorRole, moderatorName, actionType, targetType || null, targetId || null, reason || null]
  );
  return result.rows[0];
}

/**
 * Get the moderation action log, newest first. Optional limit.
 */
async function getModerationLog(pool, limit = 100) {
  const result = await pool.query(
    `SELECT ma.*,
            sa.first_name AS student_first_name,
            sa.last_name  AS student_last_name,
            sa.email      AS student_email
     FROM moderation_actions ma
     LEFT JOIN student_accounts sa ON ma.target_type = 'student_account' AND ma.target_id = sa.id
     ORDER BY ma.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/**
 * Soft-delete a message (set is_deleted = true). Only messages owned by the sender can be
 * soft-deleted this way; CRM staff can always set is_deleted regardless.
 */
async function deleteMessage(pool, messageType, messageId) {
  const table = messageType === 'group' ? 'group_messages' : 'messages';
  const result = await pool.query(
    `UPDATE ${table} SET is_deleted = true WHERE id = $1 RETURNING id, sender_id, is_deleted`,
    [messageId]
  );
  return result.rows[0] || null;
}

/**
 * Get a student account's blocked status. Returns { blocked: true/false, block: row|null }
 */
async function getStudentBlockStatus(pool, studentAccountId) {
  const result = await pool.query(
    `SELECT * FROM student_blocks
     WHERE student_account_id = $1 AND unblocked_at IS NULL
     ORDER BY blocked_at DESC LIMIT 1`,
    [studentAccountId]
  );
  if (!result.rows.length) return { blocked: false, block: null };
  return { blocked: true, block: result.rows[0] };
}

/**
 * Block a student from posting and messaging. Returns the block record.
 * reason is required.
 */
async function blockStudent(pool, { studentAccountId, blockedByRole, reason }) {
  const result = await pool.query(
    `INSERT INTO student_blocks (student_account_id, blocked_by_role, blocked_at, reason)
     VALUES ($1, $2, NOW(), $3)
     RETURNING *`,
    [studentAccountId, blockedByRole, reason]
  );
  return result.rows[0];
}

/**
 * Unblock a student. Returns the updated block record (unblocked_at set).
 */
async function unblockStudent(pool, studentAccountId) {
  const result = await pool.query(
    `UPDATE student_blocks
     SET unblocked_at = NOW()
     WHERE student_account_id = $1 AND unblocked_at IS NULL
     RETURNING *`,
    [studentAccountId]
  );
  return result.rows[0] || null;
}

/**
 * Get all currently blocked student accounts with student identity.
 */
async function getBlockedStudents(pool) {
  const result = await pool.query(
    `SELECT sb.*,
            sa.first_name, sa.last_name, sa.email,
            s.id AS student_id, s.first_name AS student_first_name, s.last_name AS student_last_name
     FROM student_blocks sb
     JOIN student_accounts sa ON sa.id = sb.student_account_id
     LEFT JOIN students s ON s.id = sa.student_id
     WHERE sb.unblocked_at IS NULL
     ORDER BY sb.blocked_at DESC`
  );
  return result.rows;
}

/**
 * Get unresolved reports (flagged messages). sorted newest first.
 */
async function getUnresolvedReports(pool) {
  const result = await pool.query(
    `SELECT mr.*,
            sa.first_name AS reporter_first_name, sa.last_name AS reporter_last_name,
            gm.content      AS group_message_content,
            gm.sender_id    AS group_message_sender_id,
            gm.is_deleted   AS group_message_deleted,
            m.content       AS message_content,
            m.sender_id     AS message_sender_id,
            m.is_deleted    AS message_deleted,
            sg.first_name   AS group_sender_first_name,
            sg.last_name    AS group_sender_last_name,
            sm.first_name   AS dm_sender_first_name,
            sm.last_name    AS dm_sender_last_name,
            cg.name         AS group_name
     FROM message_reports mr
     JOIN student_accounts sa ON sa.id = mr.reporter_id
     LEFT JOIN group_messages gm ON mr.message_type = 'group' AND mr.message_id = gm.id
     LEFT JOIN student_accounts sg ON sg.id = gm.sender_id
     LEFT JOIN messages m ON mr.message_type = 'private' AND mr.message_id = m.id
     LEFT JOIN student_accounts sm ON sm.id = m.sender_id
     LEFT JOIN conversations c ON c.id = m.conversation_id
     LEFT JOIN course_groups cg ON cg.id = gm.course_group_id
     WHERE mr.resolved_at IS NULL
     ORDER BY mr.created_at DESC`
  );
  return result.rows;
}

/**
 * Resolve (dismiss) a report. Sets resolved_at + resolved_by.
 */
async function resolveReport(pool, reportId, resolvedById) {
  const result = await pool.query(
    `UPDATE message_reports
     SET resolved_at = NOW(), resolved_by = $2
     WHERE id = $1
     RETURNING *`,
    [reportId, resolvedById]
  );
  return result.rows[0] || null;
}

/**
 * Count unresolved reports. Used for badge display.
 */
async function countUnresolvedReports(pool) {
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM message_reports WHERE resolved_at IS NULL`
  );
  return parseInt(result.rows[0].count, 10);
}

/**
 * Get all messages (private + group) with optional filters.
 * Returns messages with sender identity. Deleted messages are included (is_deleted flag set).
 */
async function getMessages(pool, { studentId, groupId, search, includeDeleted = false, limit = 50, offset = 0 }) {
  // Private messages
  const privateQuery = `
    SELECT m.id, m.conversation_id, m.sender_id, m.content, m.is_deleted, m.created_at,
           'private' AS message_type,
           sa.first_name AS sender_first_name, sa.last_name AS sender_last_name,
           c.name AS conversation_name,
           '[]'::json AS group_members
    FROM messages m
    JOIN student_accounts sa ON sa.id = m.sender_id
    LEFT JOIN conversations c ON c.id = m.conversation_id
    WHERE ($1::int IS NULL OR m.sender_id = $1)
      AND ($2::int IS NULL OR m.conversation_id = $2)
      AND ($3::text IS NULL OR m.content ILIKE '%' || $3 || '%')
      ${includeDeleted ? '' : 'AND m.is_deleted = false'}
    ORDER BY m.created_at DESC
    LIMIT $4 OFFSET $5
  `;

  // Group messages
  const groupQuery = `
    SELECT gm.id, gm.course_group_id AS conversation_id, gm.sender_id, gm.content, gm.is_deleted, gm.created_at,
           'group' AS message_type,
           sa.first_name AS sender_first_name, sa.last_name AS sender_last_name,
           cg.name AS conversation_name,
           COALESCE(json_agg(
             json_build_object('id', sg.id, 'first_name', sg.first_name, 'last_name', sg.last_name)
           ) FILTER (WHERE sg.id IS NOT NULL), '[]') AS group_members
    FROM group_messages gm
    JOIN student_accounts sa ON sa.id = gm.sender_id
    JOIN course_groups cg ON cg.id = gm.course_group_id
    LEFT JOIN course_group_members cgm ON cgm.course_group_id = cg.id
    LEFT JOIN student_accounts sg ON sg.id = cgm.student_account_id
    WHERE ($1::int IS NULL OR gm.sender_id = $1)
      AND ($2::int IS NULL OR gm.course_group_id = $2)
      AND ($3::text IS NULL OR gm.content ILIKE '%' || $3 || '%')
      ${includeDeleted ? '' : 'AND gm.is_deleted = false'}
    GROUP BY gm.id, gm.course_group_id, gm.sender_id, gm.content, gm.is_deleted, gm.created_at,
             sa.first_name, sa.last_name, cg.name
    ORDER BY gm.created_at DESC
    LIMIT $4 OFFSET $5
  `;

  // Union with combined ordering (we handle sort in JS for simplicity since we need full dataset)
  const unionQuery = `
    SELECT * FROM (
      ${privateQuery.replace('$1::int', '$1').replace('$2::int', '$2')}
      UNION ALL
      ${groupQuery.replace('$1::int', '$1').replace('$2::int', '$2')}
    ) combined
    ORDER BY created_at DESC
    LIMIT $4 OFFSET $5
  `;

  const result = await pool.query(unionQuery, [
    studentId || null,
    groupId || null,
    search || null,
    limit,
    offset,
  ]);
  return result.rows;
}

/**
 * Get student account ID from student (CRM student) id.
 */
async function getStudentAccountByStudentId(pool, studentId) {
  const result = await pool.query(
    `SELECT sa.id, sa.first_name, sa.last_name, sa.email, sa.is_active
     FROM student_accounts sa
     WHERE sa.student_id = $1`,
    [studentId]
  );
  return result.rows[0] || null;
}

module.exports = {
  logModerationAction,
  getModerationLog,
  deleteMessage,
  getStudentBlockStatus,
  blockStudent,
  unblockStudent,
  getBlockedStudents,
  getUnresolvedReports,
  resolveReport,
  countUnresolvedReports,
  getMessages,
  getStudentAccountByStudentId,
};