// routes/reseau.js
// Owns: student social network — posts, conversations, messages, group chat, reports.
// Does NOT own: CRM auth (app_users), student account creation (handled by CRM), moderation UI.
// Access: students only (student_session auth). Zero outbound notifications.
const sa = require('../db/student-accounts');

function getStudentToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

async function requireStudentAuth(req, res, next) {
  const token = getStudentToken(req);
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  const student = await sa.validateStudentSession(req.app.get('pool'), token).catch(() => null);
  if (!student) return res.status(401).json({ error: 'Session invalide ou expirée' });

  const blocked = await sa.isBlocked(req.app.get('pool'), student.id);
  req.student = student;
  req.isBlocked = blocked;
  next();
}

module.exports = function createReseauRouter({ pool }) {
  const router = require('express').Router();
  const sa = require('../db/student-accounts');

  // All routes require student auth
  router.use(requireStudentAuth);

  // ── Blocked check middleware (applied after requireStudentAuth) ───────────
  // If blocked, allow reads only — deny writes with a clear message.
  function blockWriteOnly(req, res, next) {
    if (req.isBlocked && req.method !== 'GET') {
      return res.status(403).json({ error: 'Compte temporairement suspendu du réseau social. Contactez la direction.' });
    }
    next();
  }

  // ── POST /api/reseau/posts ─────────────────────────────────────────────────
  // CRM staff (PRÉSIDENT/DIRECTRICE) create posts on the feed.
  // This route also handles student post creation (students can post to feed).
  // But currently only CRM staff post — students react/comment only.
  // POST allowed for blocked students too (they can still browse but not post).
  router.post('/posts', blockWriteOnly, async (req, res) => {
    try {
      const { title, content, image_url } = req.body;
      if (!content || !content.trim()) return res.status(400).json({ error: 'Contenu requis' });

      const result = await pool.query(
        `INSERT INTO posts (author_role, author_name, title, content, image_url)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [req.student.is_staff ? 'STUDENT' : 'STUDENT',
         `${req.student.first_name} ${req.student.last_name}`,
         title ? title.trim() : null,
         content.trim(),
         image_url || null]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('[reseau] POST /posts error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/reseau/posts ──────────────────────────────────────────────────
  router.get('/posts', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
      const result = await pool.query(
        `SELECT p.*,
                COALESCE(
                  (SELECT json_agg(json_build_object('id', r.id, 'emoji', r.emoji))
                   FROM post_reactions r WHERE r.post_id = p.id),
                  '[]'
                ) AS reactions
         FROM posts p
         WHERE p.is_deleted = false
         ORDER BY p.created_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('[reseau] GET /posts error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/reseau/posts/:id/react ───────────────────────────────────────
  router.post('/posts/:id/react', blockWriteOnly, async (req, res) => {
    try {
      const postId = parseInt(req.params.id, 10);
      if (isNaN(postId)) return res.status(400).json({ error: 'ID invalide' });
      const { emoji } = req.body;
      if (!emoji) return res.status(400).json({ error: 'Emoji requis' });

      // Upsert reaction
      await pool.query(
        `INSERT INTO post_reactions (post_id, student_account_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT (post_id, student_account_id, emoji) DO UPDATE SET emoji = EXCLUDED.emoji`,
        [postId, req.student.id, emoji]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[reseau] POST /posts/:id/react error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/reseau/conversations ──────────────────────────────────────────
  // Returns all conversations for the current student with participant names.
  router.get('/conversations', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT c.id, c.created_at,
                -- Build conversation name from participants (exclude self)
                COALESCE(
                  (SELECT string_agg(sa.first_name || ' ' || sa.last_name, ', ')
                   FROM conversation_participants cp
                   JOIN student_accounts sa ON sa.id = cp.student_account_id
                   WHERE cp.conversation_id = c.id AND cp.student_account_id != $1
                  ),
                  (SELECT string_agg(sa.first_name || ' ' || sa.last_name, ', ')
                   FROM conversation_participants cp
                   JOIN student_accounts sa ON sa.id = cp.student_account_id
                   WHERE cp.conversation_id = c.id)
                ) AS conversation_name,
                -- Last message preview
                (SELECT m.content FROM messages m
                 WHERE m.conversation_id = c.id AND m.is_deleted = false
                 ORDER BY m.created_at DESC LIMIT 1) AS last_message,
                (SELECT m.created_at FROM messages m
                 WHERE m.conversation_id = c.id AND m.is_deleted = false
                 ORDER BY m.created_at DESC LIMIT 1) AS last_message_at,
                -- Unread count for this student
                (SELECT COUNT(*) FROM messages m
                 WHERE m.conversation_id = c.id
                   AND m.sender_id != $1
                   AND m.is_deleted = false
                   AND m.id > COALESCE(
                     (SELECT MAX(read_up_to_message_id) FROM conversation_reads cr
                      WHERE cr.conversation_id = c.id AND cr.student_account_id = $1),
                     0
                   )) AS unread_count
         FROM conversations c
         WHERE EXISTS (
           SELECT 1 FROM conversation_participants cp
           WHERE cp.conversation_id = c.id AND cp.student_account_id = $1
         )
         ORDER BY last_message_at DESC NULLS LAST`,
        [req.student.id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('[reseau] GET /conversations error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/reseau/conversations ─────────────────────────────────────────
  // Start a new DM conversation with other student(s).
  router.post('/conversations', blockWriteOnly, async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { participant_ids, initial_message } = req.body;
      if (!participant_ids || !Array.isArray(participant_ids) || participant_ids.length === 0) {
        return res.status(400).json({ error: 'Au moins un participant requis' });
      }

      // Ensure self is included
      const allIds = [...new Set([...participant_ids, req.student.id])];
      if (!allIds.includes(req.student.id)) allIds.push(req.student.id);

      // Create conversation
      const convResult = await client.query(
        `INSERT INTO conversations DEFAULT VALUES RETURNING id, created_at`
      );
      const convId = convResult.rows[0].id;

      // Add all participants
      for (const sid of allIds) {
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, student_account_id)
           VALUES ($1, $2)`,
          [convId, sid]
        );
      }

      // Optionally send first message
      if (initial_message && initial_message.trim()) {
        await client.query(
          `INSERT INTO messages (conversation_id, sender_id, content)
           VALUES ($1, $2, $3)`,
          [convId, req.student.id, initial_message.trim()]
        );
      }

      await client.query('COMMIT');

      res.status(201).json({ id: convId, conversation_name: '', created_at: convResult.rows[0].created_at });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[reseau] POST /conversations error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    } finally {
      client.release();
    }
  });

  // ── GET /api/reseau/conversations/:id/messages ─────────────────────────────
  // Returns messages for a DM conversation (excludes deleted for other users).
  router.get('/conversations/:id/messages', async (req, res) => {
    try {
      const convId = parseInt(req.params.id, 10);
      if (isNaN(convId)) return res.status(400).json({ error: 'ID invalide' });

      // Verify student is a participant
      const partCheck = await pool.query(
        `SELECT 1 FROM conversation_participants
         WHERE conversation_id = $1 AND student_account_id = $2`,
        [convId, req.student.id]
      );
      if (!partCheck.rows.length) return res.status(403).json({ error: 'Accès non autorisé' });

      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const before = req.query.before ? parseInt(req.query.before, 10) : null;

      let query, params;
      if (before) {
        query = `SELECT m.id, m.sender_id, m.content, m.is_deleted, m.created_at,
                        sa.first_name, sa.last_name
                 FROM messages m
                 JOIN student_accounts sa ON sa.id = m.sender_id
                 WHERE m.conversation_id = $1 AND m.id < $2
                 ORDER BY m.created_at DESC LIMIT $3`;
        params = [convId, before, limit];
      } else {
        query = `SELECT m.id, m.sender_id, m.content, m.is_deleted, m.created_at,
                        sa.first_name, sa.last_name
                 FROM messages m
                 JOIN student_accounts sa ON sa.id = m.sender_id
                 WHERE m.conversation_id = $1
                 ORDER BY m.created_at DESC LIMIT $2`;
        params = [convId, limit];
      }

      const result = await pool.query(query, params);

      // Mark conversation as read for this student
      if (result.rows.length > 0) {
        const latestId = result.rows[0].id;
        await pool.query(
          `INSERT INTO conversation_reads (conversation_id, student_account_id, read_up_to_message_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (conversation_id, student_account_id)
           DO UPDATE SET read_up_to_message_id = $3`,
          [convId, req.student.id, latestId]
        );
      }

      res.json(result.rows.reverse()); // chronological
    } catch (err) {
      console.error('[reseau] GET /conversations/:id/messages error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/reseau/conversations/:id/messages ───────────────────────────
  // Send a DM message.
  router.post('/conversations/:id/messages', blockWriteOnly, async (req, res) => {
    try {
      const convId = parseInt(req.params.id, 10);
      if (isNaN(convId)) return res.status(400).json({ error: 'ID invalide' });
      const { content } = req.body;
      if (!content || !content.trim()) return res.status(400).json({ error: 'Message vide' });

      // Verify participant
      const partCheck = await pool.query(
        `SELECT 1 FROM conversation_participants
         WHERE conversation_id = $1 AND student_account_id = $2`,
        [convId, req.student.id]
      );
      if (!partCheck.rows.length) return res.status(403).json({ error: 'Accès non autorisé' });

      const result = await pool.query(
        `INSERT INTO messages (conversation_id, sender_id, content)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [convId, req.student.id, content.trim()]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('[reseau] POST /conversations/:id/messages error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/reseau/groups ─────────────────────────────────────────────────
  // List all course groups the student belongs to, with last-message preview and unread count.
  router.get('/groups', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT cg.id, cg.name,
                (SELECT COUNT(*) FROM course_group_members cgm2 WHERE cgm2.course_group_id = cg.id) AS member_count,
                (SELECT gm.content FROM group_messages gm
                 WHERE gm.course_group_id = cg.id AND gm.is_deleted = false
                 ORDER BY gm.created_at DESC LIMIT 1) AS last_message,
                (SELECT gm.created_at FROM group_messages gm
                 WHERE gm.course_group_id = cg.id AND gm.is_deleted = false
                 ORDER BY gm.created_at DESC LIMIT 1) AS last_message_at,
                (SELECT COUNT(*) FROM group_messages gm
                 WHERE gm.course_group_id = cg.id
                   AND gm.sender_id != $1
                   AND gm.is_deleted = false
                   AND gm.id > COALESCE(
                     (SELECT MAX(read_up_to_message_id) FROM group_reads gr
                      WHERE gr.course_group_id = cg.id AND gr.student_account_id = $1),
                     0
                   )) AS unread_count
         FROM course_groups cg
         WHERE EXISTS (
           SELECT 1 FROM course_group_members cgm
           WHERE cgm.course_group_id = cg.id AND cgm.student_account_id = $1
         )
         ORDER BY COALESCE(
           (SELECT gm.created_at FROM group_messages gm
            WHERE gm.course_group_id = cg.id AND gm.is_deleted = false
            ORDER BY gm.created_at DESC LIMIT 1), cg.created_at
         ) DESC`,
        [req.student.id]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('[reseau] GET /groups error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/reseau/groups/:id/members ─────────────────────────────────────
  // Return member names for a course group.
  router.get('/groups/:id/members', async (req, res) => {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (isNaN(groupId)) return res.status(400).json({ error: 'ID invalide' });

      // Verify membership
      const memCheck = await pool.query(
        `SELECT 1 FROM course_group_members
         WHERE course_group_id = $1 AND student_account_id = $2`,
        [groupId, req.student.id]
      );
      if (!memCheck.rows.length) return res.status(403).json({ error: 'Accès non autorisé' });

      const result = await pool.query(
        `SELECT sa.first_name, sa.last_name, sa.id
         FROM course_group_members cgm
         JOIN student_accounts sa ON sa.id = cgm.student_account_id
         WHERE cgm.course_group_id = $1
         ORDER BY sa.last_name, sa.first_name`,
        [groupId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error('[reseau] GET /groups/:id/members error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/reseau/groups/:id/messages ─────────────────────────────────────
  router.get('/groups/:id/messages', async (req, res) => {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (isNaN(groupId)) return res.status(400).json({ error: 'ID invalide' });

      // Verify membership
      const memCheck = await pool.query(
        `SELECT 1 FROM course_group_members
         WHERE course_group_id = $1 AND student_account_id = $2`,
        [groupId, req.student.id]
      );
      if (!memCheck.rows.length) return res.status(403).json({ error: 'Accès non autorisé' });

      const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
      const before = req.query.before ? parseInt(req.query.before, 10) : null;

      let query, params;
      if (before) {
        query = `SELECT gm.id, gm.course_group_id, gm.sender_id, gm.content, gm.is_deleted, gm.created_at,
                        sa.first_name, sa.last_name
                 FROM group_messages gm
                 JOIN student_accounts sa ON sa.id = gm.sender_id
                 WHERE gm.course_group_id = $1 AND gm.id < $2
                 ORDER BY gm.created_at DESC LIMIT $3`;
        params = [groupId, before, limit];
      } else {
        query = `SELECT gm.id, gm.course_group_id, gm.sender_id, gm.content, gm.is_deleted, gm.created_at,
                        sa.first_name, sa.last_name
                 FROM group_messages gm
                 JOIN student_accounts sa ON sa.id = gm.sender_id
                 WHERE gm.course_group_id = $1
                 ORDER BY gm.created_at DESC LIMIT $2`;
        params = [groupId, limit];
      }

      const result = await pool.query(query, params);

      // Mark group as read for this student
      if (result.rows.length > 0 && !before) {
        const latestId = result.rows[0].id;
        await pool.query(
          `INSERT INTO group_reads (course_group_id, student_account_id, read_up_to_message_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (course_group_id, student_account_id)
           DO UPDATE SET read_up_to_message_id = $3`,
          [groupId, req.student.id, latestId]
        );
      }

      res.json(result.rows.reverse());
    } catch (err) {
      console.error('[reseau] GET /groups/:id/messages error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/reseau/groups/:id/messages ───────────────────────────────────
  // Post a message in a group.
  router.post('/groups/:id/messages', blockWriteOnly, async (req, res) => {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (isNaN(groupId)) return res.status(400).json({ error: 'ID invalide' });
      const { content } = req.body;
      if (!content || !content.trim()) return res.status(400).json({ error: 'Message vide' });

      // Verify membership
      const memCheck = await pool.query(
        `SELECT 1 FROM course_group_members
         WHERE course_group_id = $1 AND student_account_id = $2`,
        [groupId, req.student.id]
      );
      if (!memCheck.rows.length) return res.status(403).json({ error: 'Accès non autorisé' });

      const result = await pool.query(
        `INSERT INTO group_messages (course_group_id, sender_id, content)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [groupId, req.student.id, content.trim()]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('[reseau] POST /groups/:id/messages error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/reseau/report ─────────────────────────────────────────────────
  // Report a message (private or group) for moderation review.
  // Zero notification to the reported student.
  router.post('/report', blockWriteOnly, async (req, res) => {
    try {
      const { message_type, message_id, reason } = req.body;
      if (!['private', 'group'].includes(message_type)) {
        return res.status(400).json({ error: 'Type de message invalide' });
      }
      const msgId = parseInt(message_id, 10);
      if (isNaN(msgId)) return res.status(400).json({ error: 'ID invalide' });
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'Motif de signalement requis' });

      // Prevent duplicate reports by same student for same message
      const existing = await pool.query(
        `SELECT id FROM message_reports
         WHERE reporter_id = $1 AND message_type = $2 AND message_id = $3`,
        [req.student.id, message_type, msgId]
      );
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Message déjà signalé' });
      }

      const result = await pool.query(
        `INSERT INTO message_reports (reporter_id, message_type, message_id, reason)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [req.student.id, message_type, msgId, reason.trim()]
      );
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error('[reseau] POST /report error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/reseau/me ─────────────────────────────────────────────────────
  // Return current student profile (for UI rendering).
  router.get('/me', async (req, res) => {
    res.json({
      id: req.student.id,
      student_id: req.student.student_id,
      first_name: req.student.first_name,
      last_name: req.student.last_name,
      email: req.student.email,
      is_blocked: req.isBlocked,
    });
  });

  // ── GET /api/reseau/all-groups ─────────────────────────────────────────────
  // List ALL course groups (for discovery / joining).
  router.get('/all-groups', async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT cg.id, cg.name,
                (SELECT COUNT(*) FROM course_group_members cgm WHERE cgm.course_group_id = cg.id) AS member_count,
                EXISTS (
                  SELECT 1 FROM course_group_members cgm2
                  WHERE cgm2.course_group_id = cg.id AND cgm2.student_account_id = $1
                ) AS is_member
         FROM course_groups cg
         ORDER BY cg.name`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('[reseau] GET /all-groups error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/reseau/groups/:id/join ────────────────────────────────────────
  router.post('/groups/:id/join', blockWriteOnly, async (req, res) => {
    try {
      const groupId = parseInt(req.params.id, 10);
      if (isNaN(groupId)) return res.status(400).json({ error: 'ID invalide' });

      // Verify group exists
      const group = await pool.query(`SELECT id FROM course_groups WHERE id = $1`, [groupId]);
      if (!group.rows.length) return res.status(404).json({ error: 'Groupe introuvable' });

      // Add member (upsert in case already joined)
      await pool.query(
        `INSERT INTO course_group_members (course_group_id, student_account_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [groupId, req.student.id]
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[reseau] POST /groups/:id/join error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};