// routes/moderation.js
// Owns: CRM moderation panel for the social network (messages, blocks, reports, action log).
// Accessible only to PRÉSIDENT and DIRECTRICE. No outbound notifications to students.
// Does NOT own: student_accounts creation/auth, posts, group management.

const express = require('express');
const mod = require('../db/moderation');

module.exports = function createModerationRouter({ pool, requireAuth, logAudit }) {

  const router = express.Router();

  // All routes require PRÉSIDENT or DIRECTRICE role
  function requireModerator(req, res, next) {
    if (!['PRÉSIDENT', 'DIRECTRICE'].includes(req.user?.role)) {
      return res.status(403).json({ error: 'Accès réservé à la direction' });
    }
    next();
  }

  // ── GET /api/moderation/messages ───────────────────────────────────────────
  // All messages (private + group), with optional filters.
  // Deleted messages are included so CRM can see the full history.
  router.get('/messages', requireModerator, async (req, res) => {
    try {
      const { student_id, group_id, search, limit = 50, offset = 0 } = req.query;
      const messages = await mod.getMessages(pool, {
        studentId: student_id ? parseInt(student_id, 10) : null,
        groupId: group_id ? parseInt(group_id, 10) : null,
        search: search || null,
        limit: Math.min(parseInt(limit, 10) || 50, 200),
        offset: parseInt(offset, 10) || 0,
      });
      res.json(messages);
    } catch (err) {
      console.error('[moderation] GET /messages error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── DELETE /api/moderation/messages/:type/:id ──────────────────────────────
  // Soft-delete a message. Logs the action.
  router.delete('/messages/:type/:id', requireModerator, async (req, res) => {
    try {
      const { type, id } = req.params;
      if (!['private', 'group'].includes(type)) {
        return res.status(400).json({ error: 'Type de message invalide' });
      }
      const msgId = parseInt(id, 10);
      if (isNaN(msgId)) return res.status(400).json({ error: 'ID invalide' });

      const deleted = await mod.deleteMessage(pool, type, msgId);
      if (!deleted) return res.status(404).json({ error: 'Message introuvable' });

      await mod.logModerationAction(pool, {
        moderatorRole: req.user.role,
        moderatorName: `${req.user.first_name} ${req.user.last_name}`,
        actionType: 'delete_message',
        targetType: type === 'group' ? 'group_message' : 'message',
        targetId: msgId,
        reason: null,
      });

      res.json({ deleted: true, id: msgId });
    } catch (err) {
      console.error('[moderation] DELETE /messages error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/moderation/blocks ────────────────────────────────────────────
  // List all currently blocked students.
  router.get('/blocks', requireModerator, async (req, res) => {
    try {
      const blocked = await mod.getBlockedStudents(pool);
      res.json(blocked);
    } catch (err) {
      console.error('[moderation] GET /blocks error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/moderation/blocks ───────────────────────────────────────────
  // Block a student. Requires { student_account_id, reason }.
  router.post('/blocks', requireModerator, async (req, res) => {
    try {
      const { student_account_id, reason } = req.body;
      if (!student_account_id) return res.status(400).json({ error: 'student_account_id requis' });
      if (!reason || !reason.trim()) return res.status(400).json({ error: 'Motif requis' });

      const existing = await mod.getStudentBlockStatus(pool, parseInt(student_account_id, 10));
      if (existing.blocked) {
        return res.status(409).json({ error: 'Élève déjà bloqué' });
      }

      const block = await mod.blockStudent(pool, {
        studentAccountId: parseInt(student_account_id, 10),
        blockedByRole: req.user.role,
        reason: reason.trim(),
      });

      await mod.logModerationAction(pool, {
        moderatorRole: req.user.role,
        moderatorName: `${req.user.first_name} ${req.user.last_name}`,
        actionType: 'block_student',
        targetType: 'student_account',
        targetId: parseInt(student_account_id, 10),
        reason: reason.trim(),
      });

      res.json({ blocked: true, block });
    } catch (err) {
      console.error('[moderation] POST /blocks error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── DELETE /api/moderation/blocks/:studentAccountId ───────────────────────
  // Unblock a student.
  router.delete('/blocks/:studentAccountId', requireModerator, async (req, res) => {
    try {
      const id = parseInt(req.params.studentAccountId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' });

      const unblocked = await mod.unblockStudent(pool, id);
      if (!unblocked) return res.status(404).json({ error: 'Aucun blocage actif trouvé' });

      await mod.logModerationAction(pool, {
        moderatorRole: req.user.role,
        moderatorName: `${req.user.first_name} ${req.user.last_name}`,
        actionType: 'unblock_student',
        targetType: 'student_account',
        targetId: id,
        reason: 'Déblocage manuel',
      });

      res.json({ unblocked: true });
    } catch (err) {
      console.error('[moderation] DELETE /blocks error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/moderation/reports ──────────────────────────────────────────
  // Get unresolved flagged messages.
  router.get('/reports', requireModerator, async (req, res) => {
    try {
      const reports = await mod.getUnresolvedReports(pool);
      res.json(reports);
    } catch (err) {
      console.error('[moderation] GET /reports error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/moderation/reports/count ─────────────────────────────────────
  // Badge count of unresolved reports.
  router.get('/reports/count', requireModerator, async (req, res) => {
    try {
      const count = await mod.countUnresolvedReports(pool);
      res.json({ count });
    } catch (err) {
      console.error('[moderation] GET /reports/count error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/moderation/reports/:id/resolve ─────────────────────────────
  // Mark a report as resolved (dismissed).
  router.post('/reports/:id/resolve', requireModerator, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'ID invalide' });

      const resolved = await mod.resolveReport(pool, id, req.user.id);
      if (!resolved) return res.status(404).json({ error: 'Signalement introuvable' });

      res.json({ resolved: true });
    } catch (err) {
      console.error('[moderation] POST /reports/:id/resolve error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/moderation/log ────────────────────────────────────────────────
  // Chronological action log.
  router.get('/log', requireModerator, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
      const log = await mod.getModerationLog(pool, limit);
      res.json(log);
    } catch (err) {
      console.error('[moderation] GET /log error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/moderation/groups ────────────────────────────────────────────
  // List all course groups for the filter dropdown.
  router.get('/groups', requireModerator, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name FROM course_groups ORDER BY name`
      );
      res.json(result.rows);
    } catch (err) {
      console.error('[moderation] GET /groups error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};