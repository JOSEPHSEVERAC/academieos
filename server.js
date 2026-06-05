const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const xlsx = require('xlsx');

const { sendEmail } = require('./services/email');

const app = express();
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

// ── Unauthenticated health / probe endpoint ───────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// AUTH: Helpers
// ==========================================

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}


async function logAudit(userId, userEmail, userRole, action, entityType, entityId, metadata, ipAddress) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, user_email, user_role, action, entity_type, entity_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, userEmail, userRole, action, entityType || null, entityId ? String(entityId) : null,
       metadata ? JSON.stringify(metadata) : null, ipAddress || null]
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

async function validateSession(token) {
  if (!token) return null;
  const hash = hashToken(token);
  const result = await pool.query(
    `SELECT t.user_id as uid, u.email, u.first_name, u.last_name, u.role, u.teacher_name, u.active
     FROM auth_tokens t
     JOIN app_users u ON t.user_id = u.id
     WHERE t.token_hash = $1 AND t.type = 'session' AND t.used = false AND t.expires_at > NOW() AND u.active = true`,
    [hash]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

// Paths the /appel tablet app needs — tablet sessions may access these
TABLET_ALLOWED_PATHS = [
  /^\/attendance(\/.*)?$/,
  /^\/appel-pdf\/(planning|inscription)(\?.*)?$/,
];

async function validateTabletSession(token) {
  if (!token) return null;
  const hash = hashToken(token);
  const result = await pool.query(
    `SELECT ts.id FROM tablet_sessions ts
     JOIN tablet_pins tp ON tp.id = ts.pin_id
     WHERE ts.token_hash = $1 AND ts.expires_at > NOW() AND tp.active = true`,
    [hash]
  );
  return result.rows.length > 0 ? { tablet: true } : null;
}

function getRequestToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  // Also accept ?token= query param for browser-opened URLs (PDFs, downloads)
  if (req.query && req.query.token) return req.query.token;
  return null;
}

function requireAuth(roles = null) {
  return async (req, res, next) => {
    const token = getRequestToken(req);
    const session = await validateSession(token).catch(() => null);
    if (!session) return res.status(401).json({ error: 'Non authentifié' });
    req.user = {
      id: session.uid,
      email: session.email,
      first_name: session.first_name,
      last_name: session.last_name,
      role: session.role,
      teacher_name: session.teacher_name
    };
    if (roles && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès non autorisé pour ce rôle' });
    }
    next();
  };
}

// PUBLIC API routes (no auth needed)
const PUBLIC_API_PATHS = new Set(['/disciplines', '/formulas', '/locations', '/saisons', '/saisons/active', '/health', '/api/diag/email']);

// Blanket auth middleware for /api routes
app.use('/api', async (req, res, next) => {
  // Allow public read-only routes
  if (req.method === 'GET' && PUBLIC_API_PATHS.has(req.path)) return next();
  // Allow public invite routes (validate token, accept invitation)
  if (req.path.startsWith('/invite/')) return next();
  // Allow tablet PIN auth endpoints (no CRM credentials needed)
  if (req.path.startsWith('/pin/')) return next();

  const token = getRequestToken(req);
  const session = await validateSession(token).catch(() => null);

  if (!session) {
    // Check if this is a tablet session accessing an allowed path
    const isTabletPath = TABLET_ALLOWED_PATHS.some(re => re.test(req.path));
    if (isTabletPath) {
      const tabletSession = await validateTabletSession(token).catch(() => null);
      if (tabletSession) {
        req.isTablet = true;
        return next();
      }
    }
    return res.status(401).json({ error: 'Non authentifié' });
  }

  req.user = {
    id: session.uid,
    email: session.email,
    first_name: session.first_name,
    last_name: session.last_name,
    role: session.role,
    teacher_name: session.teacher_name
  };

  // DELETE requires PRÉSIDENT role (enforced server-side)
  if (req.method === 'DELETE' && req.user.role !== 'PRÉSIDENT') {
    await logAudit(req.user.id, req.user.email, req.user.role, 'DELETE_DENIED', 'api', req.path, null, req.ip);
    return res.status(403).json({ error: 'Suppression réservée au PRÉSIDENT uniquement' });
  }

  next();
});

// Health check endpoint (required for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Archives — archived student list, restore, purge
const createArchivesRouter = require('./routes/archives');
app.use('/api/archives', createArchivesRouter({ pool, requireAuth, logAudit }));

// Student CSV export — full active-season list with financial totals (PRÉSIDENT + DIRECTRICE)
const createStudentsExportRouter = require('./routes/students-export');
app.use('/api/students', createStudentsExportRouter({ pool, requireAuth }));

// Student audit — validated changes with diff confirmation, per-field change log, financial recalc
const createStudentAuditRouter = require('./routes/student-audit');
app.use('/api/students', createStudentAuditRouter({ pool, requireAuth }));

// Payments — batch list (GET /api/payments/batch) + PATCH /api/payments/:id/payment
const createPaymentsRouter = require('./routes/payments');
app.use('/api/payments', createPaymentsRouter({ pool, requireAuth, logAudit }));

// Encaissement PWA — mobile payment entry for DIRECTRICE + PRÉSIDENT
const createEncaissementRouter = require('./routes/encaissement');
app.use('/api/encaissement', createEncaissementRouter({ pool, requireAuth, logAudit }));

// Famille groupes — titulaire/bénéficiaire groups with formule cascade
const createFamilleRouter = require('./routes/famille');
app.use('/api/famille-groupes', createFamilleRouter({ pool, requireAuth }));

// Attendance — presence recording, deselection (remove)
const createAttendanceRouter = require('./routes/attendance');
app.use('/api/attendance', createAttendanceRouter({ pool, requireAuth }));

// Attendance statistics aggregates + revenue-by-formula for dashboard
const createStatsRouter = require('./routes/stats');
app.use('/api/stats', createStatsRouter({ pool, requireAuth }));

// Email messaging — segmentation, batch send, campaign history, open tracking
const createMessagingRouter = require('./routes/messaging');
app.use('/api/messaging', createMessagingRouter({ pool, requireAuth }));

// Fiche des prix — official pricing grid + PDF export
const createFichePrixRouter = require('./routes/fiche-prix');
app.use('/api/fiche-prix', createFichePrixRouter({ pool }));

// Appel PWA — PDF exports (planning landscape + inscription portrait)
// Accessible from the tablet homepage, before and after PIN auth.
const createAppelPdfRouter = require('./routes/appel-pdf');
app.use('/api/appel-pdf', createAppelPdfRouter({ pool }));

// Comparatif inter-saisons — 3-season KPI comparison (revenues, memberships, cancellations)
const createComparatifRouter = require('./routes/comparatif');
app.use('/api/comparatif', createComparatifRouter({ pool, requireAuth }));

// Saisons — multi-season management, clone, clôture, per-saison formulas
const createSaisonsRouter = require('./routes/saisons');
app.use('/api/saisons', createSaisonsRouter({ pool, requireAuth, logAudit }));

// Classes — all CRUD moved to routes/classes.js
const createClassesRouter = require('./routes/classes');
app.use('/api/classes', createClassesRouter({ pool, requireAuth, logAudit }));

// Social network moderation — PRÉSIDENT + DIRECTRICE only
const createModerationRouter = require('./routes/moderation');
app.use('/api/moderation', createModerationRouter({ pool, requireAuth, logAudit }));

// Student social network — auth required (student_session), zero outbound notifications
const createReseauRouter = require('./routes/reseau');
app.use('/api/reseau', createReseauRouter({ pool }));

// Student auth — public (temp password login, session management)
const createStudentAuthRouter = require('./routes/student-auth');
app.use('/api/student-auth', createStudentAuthRouter({ pool }));

// Student /reseau page — served as static HTML
app.get('/reseau', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reseau.html'));
});

// Read-only guard — block write ops when the client is viewing a clôturée saison.
// The client sends X-Saison-Id header for season-scoped requests.
// Write routes that are season-context-aware check this; most legacy routes ignore it.
app.use('/api', async (req, res, next) => {
  const saisonId = req.headers['x-saison-id'];
  if (!saisonId || req.method === 'GET') return next();
  // Only enforce for mutations (POST/PUT/PATCH/DELETE) when a saison id is provided
  try {
    const r = await pool.query(`SELECT statut FROM saisons WHERE id = $1`, [saisonId]);
    if (r.rows[0] && r.rows[0].statut === 'cloturee') {
      return res.status(403).json({ error: 'Saison clôturée — lecture seule. Changez de saison pour modifier des données.' });
    }
  } catch (_) { /* non-fatal: if saison check fails, let request through */ }
  next();
});

// Service workers must never be HTTP-cached — browsers compare byte-for-byte
// on each check and skip update if the response is identical to what's cached.
// Without no-cache, a CDN or browser cache can serve a stale sw.js for hours.
app.get('/sw.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});
app.get('/sw-encaissement.js', (req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

// Explicit /paiements route — guarantees the batch-payment page is served
// regardless of any static-middleware path-resolution quirks.
app.get('/paiements', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paiements.html'));
});

// Encaissement PWA — mobile payment entry (DIRECTRICE + PRÉSIDENT)
app.get('/encaissement', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'encaissement.html'));
});



// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Root redirect — CRM app, not a marketing site.
// Authenticated users: login.html checks token and bounces to /dashboard.
// Unauthenticated users: see the login form.
app.get('/', (req, res) => {
  res.redirect('/login');
});

// ==========================================
// AUTH: Routes
// ==========================================

// Step 1: email + password → send 2FA code
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email et mot de passe requis' });

    const result = await pool.query('SELECT * FROM app_users WHERE email = $1 AND active = true', [email.toLowerCase().trim()]);
    if (result.rows.length === 0) {
      // Timing-safe: still check password to prevent user enumeration
      await bcrypt.compare(password, '$2a$10$placeholder.hash.to.prevent.timing.attack.padding');
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    }

    const user = result.rows[0];
    // User without a password_hash hasn't accepted their invitation yet
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Compte non activé — veuillez accepter votre invitation' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = hashToken(code);

    // Generate pending token for client to reference
    const pendingToken = generateToken();
    const pendingTokenHash = hashToken(pendingToken);

    // Store: pending_token_hash as token_hash, code_hash separately
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    await pool.query(
      `INSERT INTO auth_tokens (user_id, type, token_hash, code_hash, expires_at)
       VALUES ($1, '2fa_pending', $2, $3, $4)`,
      [user.id, pendingTokenHash, codeHash, expiresAt]
    );

    // Send code by email — if it fails, log the code for debugging but still return token
    const name = user.first_name || user.email;
    sendEmail(
      user.email,
      'AcadémieOS — Votre code de connexion',
      `Bonjour ${name},\n\nVotre code de vérification est : ${code}\n\nCe code expire dans 5 minutes.\n\nSi vous n'avez pas tenté de vous connecter, ignorez cet email.\n\n— AcadémieOS`
    ).catch(err => console.error(`[2fa-email] FAILED to ${user.email} — code was ${code} — error: ${err.message || err}`));

    res.json({ pending_token: pendingToken, email: user.email });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Step 2: verify 2FA code → create session
app.post('/auth/verify-2fa', async (req, res) => {
  try {
    const { pending_token, code } = req.body;
    if (!pending_token || !code) return res.status(400).json({ error: 'Token et code requis' });

    const pendingHash = hashToken(pending_token);
    const codeHash = hashToken(String(code).trim());

    const result = await pool.query(
      `SELECT t.*, u.id as uid, u.email, u.first_name, u.last_name, u.role, u.teacher_name, u.onboarding_completed_at, u.invitation_accepted_at
       FROM auth_tokens t
       JOIN app_users u ON t.user_id = u.id
       WHERE t.token_hash = $1 AND t.type = '2fa_pending' AND t.used = false AND t.expires_at > NOW()`,
      [pendingHash]
    );

    if (result.rows.length === 0) return res.status(401).json({ error: 'Code expiré ou invalide' });

    const row = result.rows[0];
    if (row.code_hash !== codeHash) {
      return res.status(401).json({ error: 'Code incorrect' });
    }

    // Mark pending token as used
    await pool.query('UPDATE auth_tokens SET used = true WHERE id = $1', [row.id]);

    // Set last_login_at
    await pool.query('UPDATE app_users SET last_login_at = NOW() WHERE id = $1', [row.user_id]);

    // Create session token (7 days)
    const sessionToken = generateToken();
    const sessionHash = hashToken(sessionToken);
    const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'session', $2, $3)`,
      [row.user_id, sessionHash, sessionExpires]
    );

    res.json({
      token: sessionToken,
      user: {
        id: row.uid,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        role: row.role,
        teacher_name: row.teacher_name,
        // Onboarding redirect: only for invited users who haven't completed it yet
        // Users created via /setup (Grégory) have invitation_accepted_at = NULL → skip onboarding
        onboarding_completed: !!(row.onboarding_completed_at || !row.invitation_accepted_at)
      }
    });
  } catch (err) {
    console.error('2FA verify error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Logout
app.post('/auth/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
      const hash = hashToken(token);
      await pool.query('UPDATE auth_tokens SET used = true WHERE token_hash = $1', [hash]);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Current user
app.get('/auth/me', requireAuth(), async (req, res) => {
  res.json({ user: req.user });
});

// ==========================================
// SETUP: First PRÉSIDENT creation
// ==========================================

app.get('/setup', async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*) FROM app_users WHERE role = \'PRÉSIDENT\'');
    if (parseInt(count.rows[0].count) > 0) {
      return res.redirect('/dashboard');
    }
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
  } catch (err) {
    // Table might not exist yet
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
  }
});

app.post('/setup', async (req, res) => {
  try {
    const count = await pool.query('SELECT COUNT(*) FROM app_users WHERE role = \'PRÉSIDENT\'');
    if (parseInt(count.rows[0].count) > 0) {
      return res.status(409).json({ error: 'Un compte PRÉSIDENT existe déjà' });
    }
    const { email, first_name, last_name, password } = req.body;
    if (!email || !first_name || !last_name || !password) {
      return res.status(400).json({ error: 'Tous les champs sont requis' });
    }
    if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum)' });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `INSERT INTO app_users (email, first_name, last_name, password_hash, role)
       VALUES ($1, $2, $3, $4, 'PRÉSIDENT') RETURNING id, email, first_name, last_name, role`,
      [email.toLowerCase().trim(), first_name.trim(), last_name.trim(), passwordHash]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    console.error('Setup error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// ADMIN: User management (PRÉSIDENT only)
// ==========================================

app.get('/api/admin/users', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, teacher_name, active, created_at,
              invitation_sent_at, invitation_accepted_at, last_login_at
       FROM app_users ORDER BY role, last_name, first_name`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/admin/users', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const { email, first_name, last_name, role, teacher_name } = req.body;
    if (!email || !first_name || !last_name || !role) {
      return res.status(400).json({ error: 'Champs requis manquants' });
    }
    const validRoles = ['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR', 'CLIENT'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });
    // No password required — invitation flow will handle password creation
    const result = await pool.query(
      `INSERT INTO app_users (email, first_name, last_name, password_hash, role, teacher_name, created_by)
       VALUES ($1, $2, $3, NULL, $4, $5, $6) RETURNING id, email, first_name, last_name, role, teacher_name, active, invitation_sent_at, invitation_accepted_at, last_login_at`,
      [email.toLowerCase().trim(), first_name.trim(), last_name.trim(), role, teacher_name || null, req.user.id]
    );
    await logAudit(req.user.id, req.user.email, req.user.role, 'USER_CREATED', 'app_users', result.rows[0].id,
      { role, email: result.rows[0].email }, req.ip);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/admin/users/:id', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const { id } = req.params;
    const { first_name, last_name, role, teacher_name, active, password } = req.body;
    const validRoles = ['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR', 'CLIENT'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Rôle invalide' });

    let updateFields = [];
    let params = [];
    let idx = 1;

    if (first_name !== undefined) { updateFields.push(`first_name = $${idx++}`); params.push(first_name.trim()); }
    if (last_name !== undefined) { updateFields.push(`last_name = $${idx++}`); params.push(last_name.trim()); }
    if (role !== undefined) { updateFields.push(`role = $${idx++}`); params.push(role); }
    if (teacher_name !== undefined) { updateFields.push(`teacher_name = $${idx++}`); params.push(teacher_name || null); }
    if (active !== undefined) { updateFields.push(`active = $${idx++}`); params.push(active); }
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court' });
      const ph = await bcrypt.hash(password, 12);
      updateFields.push(`password_hash = $${idx++}`);
      params.push(ph);
    }

    if (updateFields.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });
    updateFields.push(`updated_at = NOW()`);
    params.push(id);

    const result = await pool.query(
      `UPDATE app_users SET ${updateFields.join(', ')} WHERE id = $${idx} RETURNING id, email, first_name, last_name, role, teacher_name, active, invitation_sent_at, invitation_accepted_at, last_login_at`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    await logAudit(req.user.id, req.user.email, req.user.role, 'USER_UPDATED', 'app_users', id,
      { changes: Object.keys(req.body).filter(k => k !== 'password') }, req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Audit logs (PRÉSIDENT only)
app.get('/api/admin/audit-logs', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const { limit = 100, offset = 0, action } = req.query;
    let query = 'SELECT * FROM audit_logs WHERE 1=1';
    const params = [];
    let idx = 1;
    if (action) { query += ` AND action = $${idx++}`; params.push(action); }
    query += ` ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(Math.min(parseInt(limit), 500), parseInt(offset));
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching audit logs:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// ADMIN: Invitation management (PRÉSIDENT only)
// ==========================================

function buildInviteEmailHtml(name, appUrl, token, type = 'invite') {
  const isReset = type === 'reset';
  const link = isReset ? `${appUrl}/accept-invite?token=${token}&type=reset` : `${appUrl}/accept-invite?token=${token}`;
  const title = isReset ? 'Réinitialisation de votre mot de passe' : 'Invitation à rejoindre AcadémieOS';
  const intro = isReset
    ? `Bonjour ${name},<br><br>Une réinitialisation de votre mot de passe a été demandée par l'administrateur.`
    : `Bonjour ${name},<br><br>Vous avez été invité(e) à rejoindre <strong>AcadémieOS</strong>.`;
  const cta = isReset ? 'Définir mon nouveau mot de passe' : 'Accepter l\'invitation';
  return `<!DOCTYPE html><html><body style="font-family:'DM Sans',Arial,sans-serif;background:#faf8f5;margin:0;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:40px;box-shadow:0 2px 8px rgba(0,0,0,0.06);">
    <h1 style="font-family:Georgia,serif;font-size:26px;color:#0a0a0a;margin:0 0 8px;">${title}</h1>
    <p style="color:#555;line-height:1.6;margin:16px 0;">${intro}</p>
    <p style="color:#555;line-height:1.6;margin:0 0 28px;">Cliquez sur le bouton ci-dessous pour ${isReset ? 'définir votre mot de passe' : 'créer votre compte'}. Ce lien est valable <strong>24 heures</strong>.</p>
    <a href="${link}" style="display:inline-block;background:#0a0a0a;color:#fff;text-decoration:none;padding:14px 28px;border-radius:8px;font-weight:600;font-size:15px;">${cta}</a>
    <p style="color:#999;font-size:12px;margin-top:28px;line-height:1.5;">Si vous n'attendiez pas cet email, ignorez-le.<br>Lien : ${link}</p>
  </div></body></html>`;
}

// Send invitation (manual trigger, PRÉSIDENT only)
app.post('/api/admin/users/:id/invite', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const { id } = req.params;
    const userResult = await pool.query('SELECT * FROM app_users WHERE id = $1 AND active = true', [id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const user = userResult.rows[0];
    if (user.invitation_accepted_at) {
      return res.status(400).json({ error: 'Cet utilisateur a déjà accepté son invitation' });
    }

    const token = generateToken(40);
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await pool.query(
      `UPDATE app_users SET invitation_token_hash = $1, invitation_expires_at = $2, invitation_sent_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [tokenHash, expiresAt, id]
    );

    const appUrl = process.env.APP_URL || 'https://lacademie.art';
    const name = user.first_name;
    const html = buildInviteEmailHtml(name, appUrl, token, 'invite');
    const plain = `Bonjour ${name},\n\nVous avez été invité(e) à rejoindre AcadémieOS.\n\nAcceptez votre invitation (valable 24h) :\n${appUrl}/accept-invite?token=${token}\n\n— AcadémieOS`;

    await sendEmail(user.email, 'Invitation à rejoindre AcadémieOS', plain, html)
      .catch(err => console.error('Invite email error:', err));

    await logAudit(req.user.id, req.user.email, req.user.role, 'INVITATION_SENT', 'app_users', id,
      { target_email: user.email }, req.ip);

    res.json({ ok: true, message: `Invitation envoyée à ${user.email}` });
  } catch (err) {
    console.error('Error sending invitation:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Resend invitation (invalidates old link)
app.post('/api/admin/users/:id/reinvite', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const { id } = req.params;
    const userResult = await pool.query('SELECT * FROM app_users WHERE id = $1 AND active = true', [id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const user = userResult.rows[0];
    if (user.invitation_accepted_at) {
      return res.status(400).json({ error: 'Cet utilisateur a déjà accepté son invitation' });
    }

    const token = generateToken(40);
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h — old token overwritten

    await pool.query(
      `UPDATE app_users SET invitation_token_hash = $1, invitation_expires_at = $2, invitation_sent_at = NOW(), updated_at = NOW() WHERE id = $3`,
      [tokenHash, expiresAt, id]
    );

    const appUrl = process.env.APP_URL || 'https://lacademie.art';
    const name = user.first_name;
    const html = buildInviteEmailHtml(name, appUrl, token, 'invite');
    const plain = `Bonjour ${name},\n\nVoici votre nouveau lien d'invitation AcadémieOS (valable 24h) :\n${appUrl}/accept-invite?token=${token}\n\nLe lien précédent n'est plus valide.\n\n— AcadémieOS`;

    await sendEmail(user.email, 'Nouvelle invitation AcadémieOS', plain, html)
      .catch(err => console.error('Reinvite email error:', err));

    await logAudit(req.user.id, req.user.email, req.user.role, 'INVITATION_RESENT', 'app_users', id,
      { target_email: user.email }, req.ip);

    res.json({ ok: true, message: `Nouvelle invitation envoyée à ${user.email}` });
  } catch (err) {
    console.error('Error resending invitation:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Reset password (sends a reset link, PRÉSIDENT only)
// CRITICAL: Email must be confirmed sent BEFORE invalidating sessions
app.post('/api/admin/users/:id/reset-password', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const { id } = req.params;
    const userResult = await pool.query('SELECT * FROM app_users WHERE id = $1 AND active = true', [id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const user = userResult.rows[0];

    const token = generateToken(40);
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Reuse invitation_token fields for password reset — same acceptance page
    await pool.query(
      `UPDATE app_users SET invitation_token_hash = $1, invitation_expires_at = $2, updated_at = NOW() WHERE id = $3`,
      [tokenHash, expiresAt, id]
    );

    const appUrl = process.env.APP_URL || 'https://lacademie.art';
    const name = user.first_name;
    const html = buildInviteEmailHtml(name, appUrl, token, 'reset');
    const plain = `Bonjour ${name},\n\nUne réinitialisation de votre mot de passe a été demandée.\n\nDéfinissez votre nouveau mot de passe (lien valable 24h) :\n${appUrl}/accept-invite?token=${token}&type=reset\n\n— AcadémieOS`;

    // Send email FIRST — only invalidate sessions after confirmed delivery
    try {
      await sendEmail(user.email, 'Réinitialisation de votre mot de passe — AcadémieOS', plain, html);
    } catch (emailErr) {
      console.error('Reset password email error:', emailErr);
      // Revert token since email wasn't sent
      await pool.query(
        `UPDATE app_users SET invitation_token_hash = NULL, invitation_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return res.status(500).json({ error: "Impossible d'envoyer l'email de réinitialisation. Veuillez réessayer." });
    }

    // Email confirmed sent — NOW invalidate sessions
    await pool.query(
      `UPDATE auth_tokens SET used = true WHERE user_id = $1 AND type = 'session' AND used = false`,
      [id]
    );

    await logAudit(req.user.id, req.user.email, req.user.role, 'PASSWORD_RESET_SENT', 'app_users', id,
      { target_email: user.email }, req.ip);

    res.json({ ok: true, message: `Lien de réinitialisation envoyé à ${user.email}` });
  } catch (err) {
    console.error('Error resetting password:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// PUBLIC: Invite acceptance (no auth)
// ==========================================

// Validate invite token (used by accept-invite page on load)
app.get('/api/invite/validate/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const tokenHash = hashToken(token);
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, invitation_accepted_at
       FROM app_users
       WHERE invitation_token_hash = $1 AND invitation_expires_at > NOW() AND active = true`,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide ou expiré' });
    }
    const u = result.rows[0];
    res.json({
      email: u.email,
      first_name: u.first_name,
      last_name: u.last_name,
      role: u.role,
      already_accepted: !!u.invitation_accepted_at
    });
  } catch (err) {
    console.error('Invite validate error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Accept invite: set password, create session
app.post('/api/invite/accept', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token et mot de passe requis' });
    if (password.length < 8) return res.status(400).json({ error: 'Mot de passe trop court (8 caractères minimum)' });

    const tokenHash = hashToken(token);
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, teacher_name, invitation_accepted_at
       FROM app_users
       WHERE invitation_token_hash = $1 AND invitation_expires_at > NOW() AND active = true`,
      [tokenHash]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lien invalide ou expiré' });
    }
    const user = result.rows[0];

    const passwordHash = await bcrypt.hash(password, 12);
    const isFirstTime = !user.invitation_accepted_at;

    // Set password, mark invitation accepted, clear token
    await pool.query(
      `UPDATE app_users
       SET password_hash = $1,
           invitation_accepted_at = COALESCE(invitation_accepted_at, NOW()),
           invitation_token_hash = NULL,
           invitation_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, user.id]
    );

    await logAudit(user.id, user.email, user.role, isFirstTime ? 'INVITATION_ACCEPTED' : 'PASSWORD_RESET', 'app_users', user.id, null, null);

    if (isFirstTime) {
      // First-time invitation: create session and redirect to onboarding
      const sessionToken = generateToken();
      const sessionHash = hashToken(sessionToken);
      const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO auth_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'session', $2, $3)`,
        [user.id, sessionHash, sessionExpires]
      );
      return res.json({
        token: sessionToken,
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          teacher_name: user.teacher_name,
          onboarding_completed: false
        },
        first_time: true
      });
    } else {
      // Password reset: invalidate any remaining sessions — user must re-authenticate with 2FA
      await pool.query(
        `UPDATE auth_tokens SET used = true WHERE user_id = $1 AND type = 'session' AND used = false`,
        [user.id]
      );
      return res.json({ ok: true, first_time: false });
    }
  } catch (err) {
    console.error('Invite accept error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// PROFILE: User own profile (all roles)
// ==========================================

app.get('/api/profile', requireAuth(), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, role, teacher_name, phone, address, birth_date,
              legal_guardian, sizes, profile_photo_url, onboarding_completed_at, created_at
       FROM app_users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Profil non trouvé' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Profile get error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.put('/api/profile', requireAuth(), async (req, res) => {
  try {
    const { first_name, last_name, phone, address, birth_date, legal_guardian, sizes } = req.body;
    const updates = [];
    const params = [];
    let idx = 1;

    if (first_name !== undefined) { updates.push(`first_name = $${idx++}`); params.push(first_name.trim()); }
    if (last_name !== undefined) { updates.push(`last_name = $${idx++}`); params.push(last_name.trim()); }
    if (phone !== undefined) { updates.push(`phone = $${idx++}`); params.push(phone || null); }
    if (address !== undefined) { updates.push(`address = $${idx++}`); params.push(address || null); }
    if (birth_date !== undefined) { updates.push(`birth_date = $${idx++}`); params.push(birth_date || null); }
    if (legal_guardian !== undefined) { updates.push(`legal_guardian = $${idx++}`); params.push(legal_guardian || null); }
    if (sizes !== undefined) { updates.push(`sizes = $${idx++}`); params.push(sizes ? JSON.stringify(sizes) : null); }

    if (updates.length === 0) return res.status(400).json({ error: 'Aucun champ à modifier' });

    updates.push(`updated_at = NOW()`);
    params.push(req.user.id);

    const result = await pool.query(
      `UPDATE app_users SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, email, first_name, last_name, role, phone, address, birth_date, legal_guardian, sizes, profile_photo_url, onboarding_completed_at`,
      params
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Mark onboarding complete
app.post('/api/profile/onboarding-complete', requireAuth(), async (req, res) => {
  try {
    await pool.query(
      `UPDATE app_users SET onboarding_completed_at = COALESCE(onboarding_completed_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Onboarding complete error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Self-service password change: generates reset link and sends to own email, then invalidates session
// CRITICAL: Email must be confirmed sent BEFORE invalidating sessions — otherwise user is locked out
app.post('/api/profile/request-password-change', requireAuth(), async (req, res) => {
  try {
    const userId = req.user.id;
    const userResult = await pool.query('SELECT * FROM app_users WHERE id = $1 AND active = true', [userId]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
    const user = userResult.rows[0];

    const token = generateToken(40);
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // Store the reset token
    await pool.query(
      `UPDATE app_users SET invitation_token_hash = $1, invitation_expires_at = $2, updated_at = NOW() WHERE id = $3`,
      [tokenHash, expiresAt, userId]
    );

    const appUrl = process.env.APP_URL || 'https://lacademie.art';
    const name = user.first_name;
    const html = buildInviteEmailHtml(name, appUrl, token, 'reset');
    const plain = `Bonjour ${name},\n\nVous avez demandé la modification de votre mot de passe.\n\nDéfinissez votre nouveau mot de passe (lien valable 24h) :\n${appUrl}/accept-invite?token=${token}&type=reset\n\nSi vous n'avez pas demandé ce changement, ignorez cet email.\n\n— AcadémieOS`;

    // Send email FIRST — only proceed to session invalidation if email succeeds
    try {
      await sendEmail(user.email, 'Modification de votre mot de passe — AcadémieOS', plain, html);
    } catch (emailErr) {
      console.error('Password change email error:', emailErr);
      // Revert: clear the token since email wasn't sent — do NOT invalidate session
      await pool.query(
        `UPDATE app_users SET invitation_token_hash = NULL, invitation_expires_at = NULL, updated_at = NOW() WHERE id = $1`,
        [userId]
      );
      return res.status(500).json({ error: "Impossible d'envoyer l'email. Votre session reste active. Veuillez réessayer." });
    }

    // Email confirmed sent — NOW invalidate sessions (safe to log out)
    await pool.query(
      `UPDATE auth_tokens SET used = true WHERE user_id = $1 AND type = 'session' AND used = false`,
      [userId]
    );

    await logAudit(userId, user.email, user.role, 'PASSWORD_CHANGE_REQUESTED', 'app_users', userId,
      { source: 'self_service' }, req.ip);

    res.json({ ok: true });
  } catch (err) {
    console.error('Request password change error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// API: Disciplines
// ==========================================
app.get('/api/disciplines', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM disciplines ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching disciplines:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// API: Locations
// ==========================================
app.get('/api/locations', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM locations ORDER BY city');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching locations:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// API: Formulas (admin-managed)
// ==========================================
app.get('/api/formulas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM formulas WHERE active = true ORDER BY position, label');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching formulas:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/formulas', async (req, res) => {
  try {
    const { label } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'Label requis' });
    const maxPos = await pool.query('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM formulas');
    const result = await pool.query(
      'INSERT INTO formulas (label, position) VALUES ($1, $2) RETURNING *',
      [label.trim(), maxPos.rows[0].next]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Formule déjà existante' });
    console.error('Error creating formula:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.delete('/api/formulas/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('UPDATE formulas SET active = false WHERE id = $1 RETURNING id, label', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Formule non trouvée' });
    if (req.user) await logAudit(req.user.id, req.user.email, req.user.role, 'DELETE_FORMULA', 'formulas', id, { label: result.rows[0].label }, req.ip);
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error deleting formula:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.patch('/api/formulas/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('UPDATE formulas SET active = true WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Formule non trouvée' });
    res.json({ restored: true });
  } catch (err) {
    console.error('Error restoring formula:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// API: Students
// ==========================================

// List students with their disciplines
app.get('/api/students', async (req, res) => {
  try {
    const { search, discipline_id, active } = req.query;
    let query = `
      SELECT
        s.*,
        COALESCE(json_agg(
          json_build_object('id', d.id, 'name', d.name, 'color', d.color)
        ) FILTER (WHERE d.id IS NOT NULL), '[]') as disciplines,
        COALESCE((
          SELECT ss.adhesion_incluse
          FROM student_saisons ss
          JOIN saisons sa ON ss.saison_id = sa.id
          WHERE ss.student_id = s.id AND sa.active = TRUE
          LIMIT 1
        ), false) AS adhesion_incluse
      FROM students s
      LEFT JOIN student_disciplines sd ON s.id = sd.student_id
      LEFT JOIN disciplines d ON sd.discipline_id = d.id
      WHERE 1=1
    `;
    const params = [];
    let paramIdx = 1;

    if (search) {
      query += ` AND (LOWER(s.first_name) LIKE LOWER($${paramIdx}) OR LOWER(s.last_name) LIKE LOWER($${paramIdx}) OR LOWER(COALESCE(s.email,'')) LIKE LOWER($${paramIdx}) OR s.numero_adherent ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (discipline_id) {
      query += ` AND s.id IN (SELECT student_id FROM student_disciplines WHERE discipline_id = $${paramIdx})`;
      params.push(discipline_id);
      paramIdx++;
    }
    if (active !== undefined) {
      query += ` AND s.active = $${paramIdx}`;
      params.push(active === 'true');
      paramIdx++;
    }

    query += ' GROUP BY s.id ORDER BY s.last_name, s.first_name';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching students:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Export students as XLSX
app.get('/api/students/export', async (req, res) => {
  try {
    const { search, discipline_id, practice_levels } = req.query;

    let query = `
      SELECT
        s.last_name                                               AS "Nom",
        s.first_name                                              AS "Prénom",
        s.email                                                   AS "Email",
        s.phone                                                   AS "Téléphone",
        TO_CHAR(s.birth_date, 'DD/MM/YYYY')                      AS "Date de naissance",
        CASE WHEN s.sexe = 'M' THEN 'Masculin' WHEN s.sexe = 'F' THEN 'Féminin' ELSE '' END AS "Sexe",
        s.parent_name                                             AS "Responsable légal",
        s.parent_phone                                            AS "Tél. responsable légal",
        s.parent_email                                            AS "Email responsable légal",
        s.address                                                 AS "Adresse",
        s.postal_code                                             AS "Code postal",
        s.city                                                    AS "Ville",
        COALESCE(STRING_AGG(DISTINCT d.name, ', ' ORDER BY d.name), '') AS "Disciplines",
        ARRAY_TO_STRING(s.practice_levels, ', ')                 AS "Niveaux de pratique",
        s.formule                                                 AS "Formule tarifaire",
        s.payment_method                                          AS "Mode de paiement",
        s.size_top                                                AS "Taille haut",
        s.size_bottom                                             AS "Taille bas",
        s.shoe_size                                               AS "Pointure",
        TO_CHAR(s.date_premiere_inscription, 'DD/MM/YYYY')       AS "Date 1ère inscription",
        COALESCE(STRING_AGG(DISTINCT sa.nom, ', ' ORDER BY sa.nom), '') AS "Saison(s)",
        CASE WHEN BOOL_OR(ss.adhesion_payee) THEN 'Payée' ELSE 'Non payée' END AS "Statut adhésion"
      FROM students s
      LEFT JOIN student_disciplines sd ON s.id = sd.student_id
      LEFT JOIN disciplines d ON sd.discipline_id = d.id
      LEFT JOIN student_saisons ss ON s.id = ss.student_id
      LEFT JOIN saisons sa ON ss.saison_id = sa.id
      WHERE s.active = true
    `;

    const params = [];
    let paramIdx = 1;

    if (search) {
      query += ` AND (LOWER(s.first_name) LIKE LOWER($${paramIdx}) OR LOWER(s.last_name) LIKE LOWER($${paramIdx}) OR LOWER(COALESCE(s.email,'')) LIKE LOWER($${paramIdx}) OR s.numero_adherent ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }
    if (discipline_id) {
      query += ` AND s.id IN (SELECT student_id FROM student_disciplines WHERE discipline_id = $${paramIdx})`;
      params.push(discipline_id);
      paramIdx++;
    }
    if (practice_levels) {
      // practice_levels is comma-separated; filter students whose practice_levels array overlaps
      const levelsArr = practice_levels.split(',').filter(Boolean);
      if (levelsArr.length) {
        query += ` AND s.practice_levels && $${paramIdx}::text[]`;
        params.push(levelsArr);
        paramIdx++;
      }
    }

    query += ` GROUP BY s.id, s.last_name, s.first_name, s.email, s.phone, s.birth_date, s.sexe,
      s.parent_name, s.parent_phone, s.parent_email, s.address, s.postal_code, s.city,
      s.practice_levels, s.formule, s.payment_method, s.size_top, s.size_bottom, s.shoe_size,
      s.date_premiere_inscription
      ORDER BY s.last_name, s.first_name`;

    const result = await pool.query(query, params);

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(result.rows.length > 0 ? result.rows : [{}]);

    // Auto-fit column widths
    if (result.rows.length > 0) {
      const headers = Object.keys(result.rows[0]);
      ws['!cols'] = headers.map(h => ({
        wch: Math.min(50, Math.max(h.length + 2, ...result.rows.map(r => String(r[h] || '').length + 1)))
      }));
    }

    xlsx.utils.book_append_sheet(wb, ws, 'Élèves');

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const dateStr = new Date().toISOString().split('T')[0];
    const filename = `eleves-academie-${dateStr}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    console.error('Error exporting students:', err);
    res.status(500).json({ error: 'Erreur lors de l\'export' });
  }
});

// Get single student
app.get('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const studentResult = await pool.query(
      `SELECT s.*,
        COALESCE(json_agg(
          json_build_object('id', d.id, 'name', d.name, 'color', d.color)
        ) FILTER (WHERE d.id IS NOT NULL), '[]') as disciplines
      FROM students s
      LEFT JOIN student_disciplines sd ON s.id = sd.student_id
      LEFT JOIN disciplines d ON sd.discipline_id = d.id
      WHERE s.id = $1
      GROUP BY s.id`,
      [id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Eleve non trouve' });
    }
    const student = studentResult.rows[0];
    // Fetch amount_paid_cents and adhesion_incluse from active student_saisons
    try {
      const ssRes = await pool.query(
        `SELECT amount_paid_cents, adhesion_incluse FROM student_saisons ss
         JOIN saisons s ON ss.saison_id = s.id
         WHERE ss.student_id = $1 AND s.active = TRUE
         LIMIT 1`,
        [id]
      );
      if (ssRes.rows.length > 0) {
        student.amount_paid_cents = ssRes.rows[0].amount_paid_cents;
        student.adhesion_incluse = ssRes.rows[0].adhesion_incluse !== false;
      } else {
        student.adhesion_incluse = true;
      }
    } catch (_) { student.adhesion_incluse = true; }
    res.json(student);
  } catch (err) {
    console.error('Error fetching student:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Create student
app.post('/api/students', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      first_name, last_name, birth_date, sexe, email, phone,
      parent_name, parent_phone, parent_email, level, notes,
      formule, payment_method, address, postal_code, city,
      size_top, size_bottom, shoe_size, practice_levels,
      deux_cours_semaine, date_resiliation,
      droit_image, certificat_medical,
      discipline_ids,
      amount_paid_cents,
      adhesion_incluse,
      date_adhesion
    } = req.body;

    // Required fields: Identité (prénom, nom, date de naissance, sexe) + Contact (email, téléphone)
    const reqMissing = [];
    if (!first_name || !first_name.trim()) reqMissing.push('Prénom');
    if (!last_name || !last_name.trim()) reqMissing.push('Nom');
    if (!birth_date) reqMissing.push('Date de naissance');
    if (!sexe || !sexe.trim()) reqMissing.push('Sexe');
    if (!email || !email.trim()) reqMissing.push('Email');
    if (!phone || !phone.trim()) reqMissing.push('Téléphone');
    if (reqMissing.length > 0) {
      return res.status(400).json({ error: 'Champs obligatoires manquants : ' + reqMissing.join(', ') });
    }

    // Generate numero_adherent (SSSS-NNNN) — counter never resets
    const maxRes = await client.query(`
      SELECT MAX(CAST(SPLIT_PART(numero_adherent, '-', 2) AS INTEGER)) AS max_n
      FROM students WHERE numero_adherent IS NOT NULL
    `);
    const nextN = (maxRes.rows[0].max_n || 0) + 1;
    const saisonNomRes = await client.query('SELECT nom FROM saisons WHERE active = TRUE LIMIT 1');
    let seasonCode = '2627';
    if (saisonNomRes.rows.length > 0) {
      const nom = saisonNomRes.rows[0].nom; // e.g. "2026/2027"
      const parts = nom.match(/(\d{4})\/(\d{4})/);
      if (parts) seasonCode = parts[1].slice(2) + parts[2].slice(2);
    }
    const numeroAdherent = `${seasonCode}-${String(nextN).padStart(4, '0')}`;

    const result = await client.query(
      `INSERT INTO students (
        first_name, last_name, birth_date, sexe, email, phone,
        parent_name, parent_phone, parent_email, level, notes,
        formule, payment_method, address, postal_code, city,
        size_top, size_bottom, shoe_size, practice_levels,
        deux_cours_semaine, numero_adherent, droit_image, certificat_medical,
        date_adhesion
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, $25
      ) RETURNING *`,
      [
        first_name, last_name, birth_date || null, sexe || null, email || null, phone || null,
        parent_name || null, parent_phone || null, parent_email || null,
        level || 'debutant', notes || null,
        formule || null, payment_method || null, address || null,
        postal_code || null, city || null,
        size_top || null, size_bottom || null, shoe_size || null,
        practice_levels && practice_levels.length ? practice_levels : [],
        deux_cours_semaine === true,
        numeroAdherent,
        droit_image === true,
        certificat_medical === true,
        date_adhesion || null
      ]
    );

    const student = result.rows[0];

    // Enroll in disciplines
    if (discipline_ids && discipline_ids.length > 0) {
      for (const dId of discipline_ids) {
        await client.query(
          'INSERT INTO student_disciplines (student_id, discipline_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [student.id, dId]
        );
      }
    }

    // Link to active season with formule_id and date_resiliation
    const activeSaisonRes = await client.query('SELECT id FROM saisons WHERE active = TRUE LIMIT 1');
    if (activeSaisonRes.rows.length > 0) {
      const saisonId = activeSaisonRes.rows[0].id;
      let formuleId = null;
      if (formule) {
        const fRes = await client.query('SELECT id FROM formulas WHERE label = $1', [formule]);
        if (fRes.rows.length > 0) formuleId = fRes.rows[0].id;
      }
      await client.query(
        `INSERT INTO student_saisons (student_id, saison_id, adhesion_payee, formule_id, date_resiliation, amount_paid_cents, adhesion_incluse)
         VALUES ($1, $2, false, $3, $4, $5, $6)
         ON CONFLICT (student_id, saison_id) DO UPDATE SET
           formule_id       = COALESCE(EXCLUDED.formule_id, student_saisons.formule_id),
           date_resiliation = COALESCE(EXCLUDED.date_resiliation, student_saisons.date_resiliation),
           amount_paid_cents = COALESCE(EXCLUDED.amount_paid_cents, student_saisons.amount_paid_cents),
           adhesion_incluse = EXCLUDED.adhesion_incluse`,
        [student.id, saisonId, formuleId, date_resiliation || null, amount_paid_cents || 0, adhesion_incluse !== false]
      );
    }

    await client.query('COMMIT');

    // Re-fetch with disciplines
    const fullStudent = await pool.query(
      `SELECT s.*,
        COALESCE(json_agg(
          json_build_object('id', d.id, 'name', d.name, 'color', d.color)
        ) FILTER (WHERE d.id IS NOT NULL), '[]') as disciplines
      FROM students s
      LEFT JOIN student_disciplines sd ON s.id = sd.student_id
      LEFT JOIN disciplines d ON sd.discipline_id = d.id
      WHERE s.id = $1
      GROUP BY s.id`,
      [student.id]
    );

    const studentRow = fullStudent.rows[0];
    // Include amount_paid_cents and adhesion_incluse from student_saisons
    try {
      const ssRes = await pool.query(
        `SELECT amount_paid_cents, adhesion_incluse FROM student_saisons ss
         JOIN saisons s ON ss.saison_id = s.id
         WHERE ss.student_id = $1 AND s.active = TRUE
         LIMIT 1`,
        [student.id]
      );
      if (ssRes.rows.length > 0) {
        studentRow.amount_paid_cents = ssRes.rows[0].amount_paid_cents;
        studentRow.adhesion_incluse = ssRes.rows[0].adhesion_incluse !== false;
      } else {
        studentRow.adhesion_incluse = true;
      }
    } catch (_) { studentRow.adhesion_incluse = true; }

    res.status(201).json(studentRow);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating student:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// Update student
app.put('/api/students/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const {
      first_name, last_name, birth_date, sexe, email, phone,
      parent_name, parent_phone, parent_email, level, notes, active,
      formule, payment_method, address, postal_code, city,
      size_top, size_bottom, shoe_size, practice_levels,
      deux_cours_semaine, date_resiliation,
      droit_image, certificat_medical,
      discipline_ids,
      amount_paid_cents,
      adhesion_incluse,
      date_adhesion
    } = req.body;

    // Required fields cannot be cleared on edit
    const reqMissing = [];
    if (first_name !== undefined && (!first_name || !first_name.trim())) reqMissing.push('Prénom');
    if (last_name !== undefined && (!last_name || !last_name.trim())) reqMissing.push('Nom');
    if (birth_date !== undefined && !birth_date) reqMissing.push('Date de naissance');
    if (sexe !== undefined && (!sexe || !sexe.trim())) reqMissing.push('Sexe');
    if (email !== undefined && (!email || !email.trim())) reqMissing.push('Email');
    if (phone !== undefined && (!phone || !phone.trim())) reqMissing.push('Téléphone');
    if (reqMissing.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Champs obligatoires manquants : ' + reqMissing.join(', ') });
    }

    const result = await client.query(
      `UPDATE students SET
        first_name = COALESCE($1, first_name),
        last_name = COALESCE($2, last_name),
        birth_date = $3,
        sexe = COALESCE($4, sexe),
        email = $5,
        phone = $6,
        parent_name = $7,
        parent_phone = $8,
        parent_email = $9,
        level = COALESCE($10, level),
        notes = $11,
        active = COALESCE($12, active),
        formule = $13,
        payment_method = $14,
        address = $15,
        postal_code = $16,
        city = $17,
        size_top = $18,
        size_bottom = $19,
        shoe_size = $20,
        practice_levels = COALESCE($21, practice_levels),
        deux_cours_semaine = COALESCE($22, deux_cours_semaine),
        droit_image = COALESCE($24, droit_image),
        certificat_medical = COALESCE($25, certificat_medical),
        date_adhesion = $26,
        updated_at = NOW()
      WHERE id = $23 RETURNING *`,
      [
        first_name, last_name, birth_date || null,
        sexe || null, email || null, phone || null,
        parent_name || null, parent_phone || null, parent_email || null,
        level, notes || null, active,
        formule || null, payment_method || null, address || null,
        postal_code || null, city || null,
        size_top || null, size_bottom || null, shoe_size || null,
        practice_levels !== undefined ? (practice_levels.length ? practice_levels : []) : null,
        deux_cours_semaine !== undefined ? deux_cours_semaine === true : null,
        id,
        droit_image !== undefined ? droit_image === true : null,
        certificat_medical !== undefined ? certificat_medical === true : null,
        date_adhesion !== undefined ? (date_adhesion || null) : null
      ]
    );

    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Eleve non trouve' });
    }

    // Update disciplines if provided
    if (discipline_ids !== undefined) {
      await client.query('DELETE FROM student_disciplines WHERE student_id = $1', [id]);
      if (discipline_ids && discipline_ids.length > 0) {
        for (const dId of discipline_ids) {
          await client.query(
            'INSERT INTO student_disciplines (student_id, discipline_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [id, dId]
          );
        }
      }
    }

    // Update student_saisons for active season (formule_id, date_resiliation, amount_paid_cents, adhesion_incluse)
    if (formule !== undefined || date_resiliation !== undefined || amount_paid_cents !== undefined || adhesion_incluse !== undefined) {
      const activeSaisonUpd = await client.query('SELECT id FROM saisons WHERE active = TRUE LIMIT 1');
      if (activeSaisonUpd.rows.length > 0) {
        const saisonId = activeSaisonUpd.rows[0].id;
        let formuleId = null;
        if (formule) {
          const fRes = await client.query('SELECT id FROM formulas WHERE label = $1', [formule]);
          if (fRes.rows.length > 0) formuleId = fRes.rows[0].id;
        }
        const adhesionVal = adhesion_incluse !== undefined ? (adhesion_incluse !== false) : true;
        await client.query(
          `INSERT INTO student_saisons (student_id, saison_id, adhesion_payee, formule_id, date_resiliation, amount_paid_cents, adhesion_incluse)
           VALUES ($1, $2, false, $3, $4, $5, $6)
           ON CONFLICT (student_id, saison_id) DO UPDATE SET
             formule_id       = CASE WHEN $3 IS NOT NULL THEN $3 ELSE student_saisons.formule_id END,
             date_resiliation = $4,
             amount_paid_cents = COALESCE($5, student_saisons.amount_paid_cents),
             adhesion_incluse = $6`,
          [id, saisonId, formuleId, date_resiliation !== undefined ? (date_resiliation || null) : null, amount_paid_cents !== undefined ? amount_paid_cents : null, adhesionVal]
        );
      }
    }

    await client.query('COMMIT');

    // Re-fetch with disciplines
    const fullStudent = await pool.query(
      `SELECT s.*,
        COALESCE(json_agg(
          json_build_object('id', d.id, 'name', d.name, 'color', d.color)
        ) FILTER (WHERE d.id IS NOT NULL), '[]') as disciplines
      FROM students s
      LEFT JOIN student_disciplines sd ON s.id = sd.student_id
      LEFT JOIN disciplines d ON sd.discipline_id = d.id
      WHERE s.id = $1
      GROUP BY s.id`,
      [id]
    );

    const studentRow = fullStudent.rows[0];
    // Include amount_paid_cents and adhesion_incluse from student_saisons
    try {
      const ssRes = await pool.query(
        `SELECT amount_paid_cents, adhesion_incluse FROM student_saisons ss
         JOIN saisons s ON ss.saison_id = s.id
         WHERE ss.student_id = $1 AND s.active = TRUE
         LIMIT 1`,
        [id]
      );
      if (ssRes.rows.length > 0) {
        studentRow.amount_paid_cents = ssRes.rows[0].amount_paid_cents;
        studentRow.adhesion_incluse = ssRes.rows[0].adhesion_incluse !== false;
      } else {
        studentRow.adhesion_incluse = true;
      }
    } catch (_) { studentRow.adhesion_incluse = true; }

    res.json(studentRow);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating student:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// Archive student (soft delete — sets active=false + archived_at timestamp)
app.delete('/api/students/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE students SET active = false, archived_at = NOW() WHERE id = $1 AND active = true RETURNING id, first_name, last_name',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Eleve non trouve' });
    }
    if (req.user) await logAudit(req.user.id, req.user.email, req.user.role, 'ARCHIVE_STUDENT', 'students', id,
      { name: `${result.rows[0].first_name} ${result.rows[0].last_name}` }, req.ip);
    res.json({ archived: true });
  } catch (err) {
    console.error('Error archiving student:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Restore student (legacy endpoint — clears archived_at alongside active=true)
app.patch('/api/students/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE students SET active = true, archived_at = NULL WHERE id = $1 RETURNING id',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Eleve non trouve' });
    }
    res.json({ restored: true });
  } catch (err) {
    console.error('Error restoring student:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// API: Famille Groupes (Illimité Famille)
// ==========================================

// GET /api/famille-groupes — list all groups with titulaire + beneficiaires
app.get('/api/famille-groupes', async (req, res) => {
  try {
    const groups = await pool.query(`
      SELECT fg.id, fg.titulaire_student_id,
        t.first_name || ' ' || t.last_name AS titulaire_name,
        COALESCE(
          json_agg(
            json_build_object(
              'id', fb.beneficiaire_student_id,
              'name', b.first_name || ' ' || b.last_name
            )
          ) FILTER (WHERE fb.id IS NOT NULL), '[]'
        ) AS beneficiaires
      FROM famille_groupes fg
      JOIN students t ON fg.titulaire_student_id = t.id
      LEFT JOIN famille_beneficiaires fb ON fg.id = fb.groupe_id
      LEFT JOIN students b ON fb.beneficiaire_student_id = b.id
      GROUP BY fg.id, fg.titulaire_student_id, t.first_name, t.last_name
      ORDER BY t.last_name, t.first_name
    `);
    res.json(groups.rows);
  } catch (err) {
    console.error('Error fetching famille groupes:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/students/:id/famille — famille role for a student
app.get('/api/students/:id/famille', async (req, res) => {
  try {
    const { id } = req.params;
    const sid = parseInt(id);

    // Is this student a titulaire?
    const tResult = await pool.query(
      `SELECT fg.id AS groupe_id,
        COALESCE(
          json_agg(
            json_build_object(
              'id', fb.beneficiaire_student_id,
              'name', b.first_name || ' ' || b.last_name
            )
          ) FILTER (WHERE fb.id IS NOT NULL), '[]'
        ) AS beneficiaires
       FROM famille_groupes fg
       LEFT JOIN famille_beneficiaires fb ON fg.id = fb.groupe_id
       LEFT JOIN students b ON fb.beneficiaire_student_id = b.id
       WHERE fg.titulaire_student_id = $1
       GROUP BY fg.id`,
      [sid]
    );
    if (tResult.rows.length > 0) {
      return res.json({ role: 'titulaire', groupe_id: tResult.rows[0].groupe_id, beneficiaires: tResult.rows[0].beneficiaires });
    }

    // Is this student a beneficiaire?
    const bResult = await pool.query(
      `SELECT fg.id AS groupe_id, fg.titulaire_student_id,
        t.first_name || ' ' || t.last_name AS titulaire_name
       FROM famille_beneficiaires fb
       JOIN famille_groupes fg ON fb.groupe_id = fg.id
       JOIN students t ON fg.titulaire_student_id = t.id
       WHERE fb.beneficiaire_student_id = $1`,
      [sid]
    );
    if (bResult.rows.length > 0) {
      const row = bResult.rows[0];
      return res.json({ role: 'beneficiaire', groupe_id: row.groupe_id, titulaire_id: row.titulaire_student_id, titulaire_name: row.titulaire_name });
    }

    res.json({ role: null });
  } catch (err) {
    console.error('Error fetching student famille:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/famille-groupes/available-beneficiaires — students eligible as bénéficiaire
// Only shows: students with no formule, or already in "Illimité famille (bénéficiaire)".
// Excludes: students with any other formule, and the titulaire themselves.
app.get('/api/famille-groupes/available-beneficiaires', async (req, res) => {
  try {
    const excludeTitulaire = req.query.exclude_titulaire_id ? parseInt(req.query.exclude_titulaire_id) : null;
    const params = [];
    let paramIdx = 1;
    let excludeClause = '';
    if (excludeTitulaire) {
      excludeClause = `AND s.id != $${paramIdx}`;
      params.push(excludeTitulaire);
      paramIdx++;
    }
    const result = await pool.query(`
      SELECT s.id, s.first_name, s.last_name, s.formule
      FROM students s
      WHERE s.active = true
        AND s.id NOT IN (SELECT titulaire_student_id FROM famille_groupes)
        AND (s.formule IS NULL OR s.formule = '' OR s.formule = 'Illimité famille (bénéficiaire)')
        ${excludeClause}
      ORDER BY s.last_name, s.first_name
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching available beneficiaires:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/famille-groupes/available-titulaires — students with "Illimité famille" (titulaire) who have room for more bénéficiaires
// When exclude_beneficiaire_id is provided (editing an existing bénéficiaire), that student is excluded from the capacity
// count so their current titulaire still appears as available even when the group is at capacity.
app.get('/api/famille-groupes/available-titulaires', async (req, res) => {
  try {
    const excludeBeneficiaire = req.query.exclude_beneficiaire_id ? parseInt(req.query.exclude_beneficiaire_id) : null;
    const params = excludeBeneficiaire ? [excludeBeneficiaire] : [];
    // Count existing bénéficiaires, excluding the student being edited so their current titulaire remains selectable
    const countExclusion = excludeBeneficiaire
      ? `AND fb2.beneficiaire_student_id != $1`
      : '';
    const result = await pool.query(`
      SELECT s.id, s.first_name, s.last_name,
        fg.id AS groupe_id,
        COALESCE((SELECT COUNT(*) FROM famille_beneficiaires fb2 WHERE fb2.groupe_id = fg.id ${countExclusion}), 0) AS beneficiaire_count
      FROM students s
      LEFT JOIN famille_groupes fg ON fg.titulaire_student_id = s.id
      WHERE s.active = true
        AND s.formule = 'Illimité famille'
        AND COALESCE((SELECT COUNT(*) FROM famille_beneficiaires fb2 WHERE fb2.groupe_id = fg.id ${countExclusion}), 0) < 2
      ORDER BY s.last_name, s.first_name
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching available titulaires:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// POST /api/famille-groupes/link-beneficiaire — link a bénéficiaire to a titulaire's group
app.post('/api/famille-groupes/link-beneficiaire', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { titulaire_student_id, beneficiaire_student_id } = req.body;
    if (!titulaire_student_id || !beneficiaire_student_id) {
      return res.status(400).json({ error: 'titulaire_student_id et beneficiaire_student_id requis' });
    }

    // Get or verify the titulaire's group
    const groupRes = await client.query(
      'SELECT id FROM famille_groupes WHERE titulaire_student_id = $1',
      [titulaire_student_id]
    );
    let groupId;
    if (groupRes.rows.length === 0) {
      // Create group for the titulaire
      const newGroup = await client.query(
        'INSERT INTO famille_groupes (titulaire_student_id) VALUES ($1) RETURNING id',
        [titulaire_student_id]
      );
      groupId = newGroup.rows[0].id;
    } else {
      groupId = groupRes.rows[0].id;
    }

    // Check max 2 bénéficiaires
    const countRes = await client.query(
      'SELECT COUNT(*) AS cnt FROM famille_beneficiaires WHERE groupe_id = $1',
      [groupId]
    );
    if (parseInt(countRes.rows[0].cnt) >= 2) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Ce groupe a déjà 2 bénéficiaires (maximum atteint)' });
    }

    // Remove from any existing group first
    await client.query(
      'DELETE FROM famille_beneficiaires WHERE beneficiaire_student_id = $1',
      [beneficiaire_student_id]
    );

    // Link bénéficiaire to group
    await client.query(
      'INSERT INTO famille_beneficiaires (groupe_id, beneficiaire_student_id) VALUES ($1, $2)',
      [groupId, beneficiaire_student_id]
    );

    await client.query('COMMIT');
    res.status(201).json({ groupe_id: groupId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ce bénéficiaire est déjà dans un groupe' });
    console.error('Error linking beneficiaire:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// POST /api/famille-groupes — create a new groupe with titulaire (+ optional beneficiaires)
app.post('/api/famille-groupes', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { titulaire_student_id, beneficiaire_ids } = req.body;
    if (!titulaire_student_id) return res.status(400).json({ error: 'titulaire_student_id requis' });

    // Ensure the titulaire is not already a beneficiaire
    const check = await client.query(
      'SELECT id FROM famille_beneficiaires WHERE beneficiaire_student_id = $1', [titulaire_student_id]
    );
    if (check.rows.length > 0) return res.status(409).json({ error: 'Cet élève est déjà bénéficiaire d\'un autre groupe' });

    // Create or get group
    const groupResult = await client.query(
      `INSERT INTO famille_groupes (titulaire_student_id) VALUES ($1)
       ON CONFLICT (titulaire_student_id) DO UPDATE SET titulaire_student_id = EXCLUDED.titulaire_student_id
       RETURNING id`,
      [titulaire_student_id]
    );
    const groupId = groupResult.rows[0].id;

    // Replace beneficiaires
    await client.query('DELETE FROM famille_beneficiaires WHERE groupe_id = $1', [groupId]);
    const bIds = (beneficiaire_ids || []).slice(0, 2);
    for (const bid of bIds) {
      if (bid === titulaire_student_id) continue;
      await client.query(
        'INSERT INTO famille_beneficiaires (groupe_id, beneficiaire_student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [groupId, bid]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ groupe_id: groupId });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Ce groupe ou bénéficiaire existe déjà' });
    console.error('Error creating famille groupe:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// PUT /api/famille-groupes/:id — update beneficiaires of a group
app.put('/api/famille-groupes/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id } = req.params;
    const { beneficiaire_ids } = req.body;

    const group = await client.query('SELECT titulaire_student_id FROM famille_groupes WHERE id = $1', [id]);
    if (group.rows.length === 0) return res.status(404).json({ error: 'Groupe non trouvé' });
    const titulaire_id = group.rows[0].titulaire_student_id;

    await client.query('DELETE FROM famille_beneficiaires WHERE groupe_id = $1', [id]);
    const bIds = (beneficiaire_ids || []).slice(0, 2);
    for (const bid of bIds) {
      if (bid === titulaire_id) continue;
      await client.query(
        'INSERT INTO famille_beneficiaires (groupe_id, beneficiaire_student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [id, bid]
      );
    }

    await client.query('COMMIT');
    res.json({ updated: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'Un bénéficiaire est déjà dans un autre groupe' });
    console.error('Error updating famille groupe:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  } finally {
    client.release();
  }
});

// DELETE /api/famille-groupes/:id — remove a groupe (cascades to beneficiaires)
app.delete('/api/famille-groupes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM famille_groupes WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Groupe non trouvé' });
    res.json({ deleted: true });
  } catch (err) {
    console.error('Error deleting famille groupe:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});


// ==========================================
// API: Attendance
// ==========================================

// Attendance endpoints moved to routes/attendance.js

// ==========================================
// API: Dashboard stats
// ==========================================
app.get('/api/stats', async (req, res) => {
  try {
    const saisonId = req.query.saison_id;

    // Resolve saison_id: param → active saison
    let targetSaisonId = saisonId;
    if (!targetSaisonId) {
      const ar = await pool.query('SELECT id FROM saisons WHERE active = TRUE LIMIT 1');
      if (ar.rows[0]) targetSaisonId = ar.rows[0].id;
    }

    let saisonFilter = '';
    const statsParams = [];
    if (targetSaisonId) {
      saisonFilter = ' AND ss.saison_id = $1';
      statsParams.push(targetSaisonId);
    }

    const [students, classes, attendance, disciplines, revenue] = await Promise.all([
      // actif/inactif based on adhesion_incluse in the selected season
      pool.query(`
        SELECT
          COUNT(*)::int AS total_students,
          COUNT(*) FILTER (WHERE COALESCE(ss.adhesion_incluse, false) = true)::int AS actif_students,
          COUNT(*) FILTER (WHERE COALESCE(ss.adhesion_incluse, false) = false)::int AS inactif_students
        FROM students s
        JOIN student_saisons ss ON ss.student_id = s.id
        WHERE s.archived_at IS NULL${saisonFilter ? ` AND ss.saison_id = $1` : ''}
      `, statsParams),
      pool.query('SELECT COUNT(*) as total FROM classes WHERE active = true'),
      pool.query(`SELECT COUNT(*) as today FROM attendance WHERE session_date = CURRENT_DATE AND status = 'present'`),
      pool.query('SELECT COUNT(*) as total FROM disciplines'),
      // Revenue query already filters by active saison — ignore saison_id param for revenue (matches other stats)
      pool.query(`
        SELECT
          COALESCE(SUM(
            CASE
              WHEN f.periodicite = 'mensuel' THEN
                2500 + f.prix_cents * CASE
                  WHEN ss.date_resiliation IS NOT NULL THEN
                    GREATEST(1, LEAST(10,
                      EXTRACT(MONTH FROM AGE(ss.date_resiliation::date, sa.date_debut::date))::integer + 1
                    ))
                  ELSE 10
                END
              WHEN f.periodicite LIKE '%unit%' THEN
                2500 + 1500 * ss.cours_unite_count
              WHEN f.periodicite = 'unique' THEN f.prix_cents
              ELSE 0
            END
          ), 0) AS revenu_eleves_cents,
          (SELECT COALESCE(SUM(count), 0) * 1500
           FROM class_passagers cp
           JOIN classes cl ON cp.class_id = cl.id
           JOIN saisons sa2 ON cp.session_date BETWEEN sa2.date_debut AND sa2.date_fin
           WHERE sa2.active = TRUE
          ) AS revenu_passagers_cents
        FROM student_saisons ss
        JOIN saisons sa ON ss.saison_id = sa.id
        LEFT JOIN formulas f ON ss.formule_id = f.id
        WHERE sa.active = TRUE
      `)
    ]);

    const rev = revenue.rows[0];
    const revenuEleves = parseInt(rev.revenu_eleves_cents || 0);
    const revenuPassagers = parseInt(rev.revenu_passagers_cents || 0);

    const s = students.rows[0] || {};
    res.json({
      total_students:    s.total_students    ?? 0,
      actif_students:   s.actif_students    ?? 0,
      inactif_students: s.inactif_students  ?? 0,
      total_classes:     parseInt(classes.rows[0].total),
      today_attendance:  parseInt(attendance.rows[0].today),
      total_disciplines: parseInt(disciplines.rows[0].total),
      revenu_eleves_cents: revenuEleves,
      revenu_passagers_cents: revenuPassagers,
      revenu_total_cents: revenuEleves + revenuPassagers
    });
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Classes endpoints moved to routes/classes.js.

// ==========================================
// PDF: Fiche élève
// ==========================================
app.get('/api/students/:id/pdf', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT s.*,
        COALESCE(json_agg(
          json_build_object('id', d.id, 'name', d.name, 'color', d.color)
        ) FILTER (WHERE d.id IS NOT NULL), '[]') as disciplines
      FROM students s
      LEFT JOIN student_disciplines sd ON s.id = sd.student_id
      LEFT JOIN disciplines d ON sd.discipline_id = d.id
      WHERE s.id = $1
      GROUP BY s.id`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Élève non trouvé' });
    }
    const s = result.rows[0];

    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    res.setHeader('Content-Type', 'application/pdf');
    const fn = `fiche-${(s.last_name || 'eleve').toLowerCase().replace(/\s+/g, '-')}.pdf`;
    res.setHeader('Content-Disposition', `inline; filename="${fn}"`);
    doc.pipe(res);

    const W = 595.28;
    const MARGIN = 46;
    const CW = W - MARGIN * 2;
    const GAP = 12;
    const HW = (CW - GAP) / 2;
    const TW = (CW - GAP * 2) / 3;
    const INK = '#0a0a0a';
    const ROSE = '#c44d56';
    const MUTED = '#9a9a9a';
    const SLATE = '#555555';
    const FIELDBG = '#f5f3f0';

    // --- Header band ---
    doc.rect(0, 0, W, 68).fill(INK);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text("L'ACADÉMIE", MARGIN, 18, { width: CW });
    doc.fillColor('rgba(255,255,255,0.6)').font('Helvetica').fontSize(9).text("Fiche d'inscription élève", MARGIN, 43, { width: CW });

    // --- Student name ---
    const fullName = `${s.first_name || ''} ${(s.last_name || '').toUpperCase()}`.trim();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(21).text(fullName, MARGIN, 82, { width: CW });

    // Divider
    doc.moveTo(MARGIN, 115).lineTo(W - MARGIN, 115).strokeColor('#e0ddd9').lineWidth(1).stroke();

    let y = 125;

    function sectionLabel(label) {
      doc.fillColor(ROSE).font('Helvetica-Bold').fontSize(7.5)
        .text(label.toUpperCase(), MARGIN, y, { width: CW, characterSpacing: 1.2 });
      y += 14;
    }

    function field(label, value, x, w) {
      const val = (value != null && value !== '') ? String(value) : '—';
      doc.rect(x, y, w, 38).fillColor(FIELDBG).fill();
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(label, x + 8, y + 7, { width: w - 16 });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(val, x + 8, y + 19, { width: w - 16, ellipsis: true });
    }

    function fieldFull(label, value, h) {
      const val = (value != null && value !== '') ? String(value) : '—';
      doc.rect(MARGIN, y, CW, h).fillColor(FIELDBG).fill();
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(label, MARGIN + 8, y + 7, { width: CW - 16 });
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(val, MARGIN + 8, y + 19, { width: CW - 16, height: h - 24, ellipsis: true });
    }

    // --- IDENTITÉ ---
    sectionLabel('Identité');
    field('Prénom', s.first_name, MARGIN, HW);
    field('Nom', s.last_name ? s.last_name.toUpperCase() : null, MARGIN + HW + GAP, HW);
    y += 44;
    const birthFmt = s.birth_date ? new Date(s.birth_date).toLocaleDateString('fr-FR') : null;
    const sexeMap = { M: 'Masculin', F: 'Féminin' };
    field('Date de naissance', birthFmt, MARGIN, HW);
    field('Sexe', sexeMap[s.sexe] || s.sexe, MARGIN + HW + GAP, HW);
    y += 48;

    // --- COORDONNÉES ---
    sectionLabel('Coordonnées');
    field('Email', s.email, MARGIN, HW);
    field('Téléphone', s.phone, MARGIN + HW + GAP, HW);
    y += 44;
    const addr = [s.address, s.postal_code && s.city ? `${s.postal_code} ${s.city}` : (s.postal_code || s.city)].filter(Boolean).join(', ');
    fieldFull('Adresse', addr || null, 40);
    y += 46;

    // --- PARENT ---
    sectionLabel('Parent / Responsable légal');
    field('Nom du parent', s.parent_name, MARGIN, HW);
    field('Tél. parent', s.parent_phone, MARGIN + HW + GAP, HW);
    y += 44;
    fieldFull('Email parent', s.parent_email, 38);
    y += 46;

    // --- PRATIQUE ---
    sectionLabel('Pratique & Inscription');
    field('Formule', s.formule, MARGIN, HW);
    field('Mode de paiement', s.payment_method, MARGIN + HW + GAP, HW);
    y += 44;
    const discList = (s.disciplines || []).map(d => d.name).join('  ·  ');
    fieldFull('Disciplines', discList || null, 38);
    y += 44;
    const pratLevels = Array.isArray(s.practice_levels) && s.practice_levels.length
      ? s.practice_levels.join('  ·  ')
      : null;
    fieldFull('Niveaux de pratique', pratLevels, 38);
    y += 46;

    // --- TAILLES ---
    sectionLabel('Tailles & Pointure');
    field('Taille haut', s.size_top, MARGIN, TW);
    field('Taille bas', s.size_bottom, MARGIN + TW + GAP, TW);
    field('Pointure', s.shoe_size, MARGIN + (TW + GAP) * 2, TW);
    y += 46;

    // --- NOTES ---
    if (s.notes) {
      sectionLabel('Notes');
      fieldFull('Remarques', s.notes, 54);
    }

    // --- Footer ---
    const now = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(`Document généré le ${now} • L'Académie`, MARGIN, 812, { width: CW, align: 'center' });

    doc.end();
  } catch (err) {
    console.error('Error generating student PDF:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF' });
  }
});

// ==========================================
// PDF: Emploi du temps
// ==========================================
app.get('/api/schedule/pdf', async (req, res) => {
  try {
    const { location_id } = req.query;
    let query = `
      SELECT c.*,
        d.name as discipline_name, d.color as discipline_color,
        l.name as location_name, l.city as location_city
      FROM classes c
      JOIN disciplines d ON c.discipline_id = d.id
      JOIN locations l ON c.location_id = l.id
      WHERE c.active = true
    `;
    const params = [];
    if (location_id) {
      query += ' AND c.location_id = $1';
      params.push(location_id);
    }
    query += ' ORDER BY c.day_of_week, c.start_time';

    const result = await pool.query(query, params);
    const classes = result.rows;

    // Get active saison
    const saisonRes = await pool.query('SELECT * FROM saisons WHERE active = TRUE LIMIT 1');
    const saison = saisonRes.rows[0];
    const saisonLabel = saison ? saison.nom : 'Saison en cours';

    // Determine location label
    const showAllSites = !location_id;
    let locationLabel = 'Tous les sites';
    if (location_id && classes.length > 0) {
      locationLabel = classes[0].location_city || classes[0].location_name;
    } else if (showAllSites && classes.length > 0) {
      const locRes = await pool.query('SELECT DISTINCT city FROM locations ORDER BY city');
      if (locRes.rows.length > 0) locationLabel = locRes.rows.map(r => r.city).join(' & ');
    }

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="emploi-du-temps-${locationLabel.toLowerCase().replace(/[^a-z0-9]/g, '-')}.pdf"`);
    doc.pipe(res);

    const PW = 841.89;
    const PH = 595.28;
    const MARGIN = 14;
    const CW = PW - MARGIN * 2;
    const INK = '#1a1a1a';
    const ROSE = '#c44d56';
    const MUTED = '#888888';
    const SLATE = '#444444';
    const LOC_COLORS = {
      'Arcachon': { bg: '#e0edff', text: '#1e40af', accent: '#3b82f6' },
      'Gujan-Mestras': { bg: '#fce7f3', text: '#9d174d', accent: '#ec4899' }
    };

    // === HEADER (compact, elegant) ===
    const HEADER_H = 52;
    doc.rect(0, 0, PW, HEADER_H).fill(INK);
    // School name
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18)
      .text("L'ACAD\u00c9MIE", MARGIN + 8, 10, { continued: false });
    doc.fillColor('#ffffff').font('Helvetica').fontSize(8)
      .text('Joseph-S\u00e9verac', MARGIN + 8, 30);
    // Right side: season + subtitle
    doc.fillColor('rgba(255,255,255,0.85)').font('Helvetica-Bold').fontSize(10)
      .text('Emploi du Temps', PW - MARGIN - 260, 11, { width: 250, align: 'right' });
    doc.fillColor('rgba(255,255,255,0.6)').font('Helvetica').fontSize(8)
      .text(`${saisonLabel} \u2014 ${locationLabel}`, PW - MARGIN - 260, 25, { width: 250, align: 'right' });
    const now = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
    doc.fillColor('rgba(255,255,255,0.4)').font('Helvetica').fontSize(7)
      .text(`Export\u00e9 le ${now}`, PW - MARGIN - 260, 37, { width: 250, align: 'right' });

    // Location legend (always shown — lists the school(s) present in the export)
    {
      const legendY = HEADER_H + 3;
      let legendX = MARGIN + 8;
      doc.rect(0, HEADER_H, PW, 16).fill('#f0eee9');
      // Collect which cities are actually in this export
      const citiesInExport = [...new Set(classes.map(c => c.location_city).filter(Boolean))].sort();
      citiesInExport.forEach(city => {
        const colors = LOC_COLORS[city] || { bg: '#f0f0f0', text: '#555', accent: ROSE };
        doc.rect(legendX, legendY + 2, 8, 8).fillColor(colors.accent).fill();
        doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(7)
          .text(city, legendX + 11, legendY + 3);
        legendX += doc.widthOfString(city, { font: 'Helvetica-Bold', fontSize: 7 }) + 26;
      });
    }

    const LEGEND_H = 16;
    const GRID_Y = HEADER_H + LEGEND_H;
    const FOOTER_H = 16;
    const GRID_H = PH - GRID_Y - MARGIN - FOOTER_H;

    const TIME_W = 42;
    const DAYS_W = CW - TIME_W;
    const DAY_W = DAYS_W / 6;

    // Group by day+hour
    const classMap = {};
    classes.forEach(c => {
      const h = parseInt((c.start_time || '').split(':')[0]);
      const key = c.day_of_week + '-' + h;
      if (!classMap[key]) classMap[key] = [];
      classMap[key].push(c);
    });

    const DAY_NUMS = [1, 2, 3, 4, 5, 6];
    const DAYS_LABELS = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];
    const allHours = classes.map(c => parseInt((c.start_time || '08').split(':')[0]));
    const minH = allHours.length ? Math.min(...allHours) : 8;
    const maxH = allHours.length ? Math.max(...allHours) : 20;
    const hourCount = maxH - minH + 1;

    const DAY_HDR_H = 20;
    const DATA_H = GRID_H - DAY_HDR_H;

    // Row heights: proportional to content density
    const rawHeights = [];
    for (let h = minH; h <= maxH; h++) {
      let maxCls = 0;
      DAY_NUMS.forEach(d => {
        const n = (classMap[d + '-' + h] || []).length;
        if (n > maxCls) maxCls = n;
      });
      rawHeights.push(Math.max(1, maxCls));
    }
    const totalUnits = rawHeights.reduce((a, b) => a + b, 0);
    const rowHeights = rawHeights.map(u => Math.max(22, (u / totalUnits) * DATA_H));
    // Re-normalize after min-height enforcement
    const actualTotal = rowHeights.reduce((a, b) => a + b, 0);
    const scale = DATA_H / actualTotal;
    const finalRowHeights = rowHeights.map(h => h * scale);

    // Grid background
    doc.rect(MARGIN, GRID_Y, CW, GRID_H).fillColor('#faf8f5').fill();

    // Day header row
    doc.rect(MARGIN, GRID_Y, TIME_W, DAY_HDR_H).fillColor('#2d2d2d').fill();
    DAYS_LABELS.forEach((day, i) => {
      const x = MARGIN + TIME_W + i * DAY_W;
      doc.rect(x, GRID_Y, DAY_W, DAY_HDR_H).fillColor('#2d2d2d').fill();
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7)
        .text(day, x, GRID_Y + (DAY_HDR_H - 7) / 2, { width: DAY_W, align: 'center' });
    });

    // Hour rows
    let rowY = GRID_Y + DAY_HDR_H;
    for (let hi = 0; hi < hourCount; hi++) {
      const h = minH + hi;
      const rh = finalRowHeights[hi];
      const rowBg = hi % 2 === 0 ? '#ffffff' : '#faf8f5';
      const timeBg = hi % 2 === 0 ? '#eae7e2' : '#e2dfda';

      // Time cell
      doc.rect(MARGIN, rowY, TIME_W, rh).fillColor(timeBg).fill();
      doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(7)
        .text(`${String(h).padStart(2, '0')}h`, MARGIN, rowY + Math.max(0, (rh - 7) / 2), { width: TIME_W, align: 'center' });

      // Day cells
      DAY_NUMS.forEach((d, di) => {
        const x = MARGIN + TIME_W + di * DAY_W;
        const cls = classMap[d + '-' + h] || [];
        doc.rect(x, rowY, DAY_W, rh).fillColor(rowBg).fill();

        if (cls.length > 0) {
          const PAD = 1.5;
          const GAP = 1;
          const availH = rh - PAD * 2;
          const cardH = (availH - GAP * (cls.length - 1)) / cls.length;

          cls.forEach((c, ci) => {
            const cy = rowY + PAD + ci * (cardH + GAP);
            const ch = cardH;
            const color = c.discipline_color || ROSE;

            // Location-based styling (same for single and combined view)
            const locColors = c.location_city ? (LOC_COLORS[c.location_city] || { bg: '#f0f0f0', text: '#555', accent: color }) : null;
            const cardBg = locColors ? locColors.bg : (color + '15');
            const accentColor = locColors ? locColors.accent : color;

            // Card background
            doc.rect(x + 2, cy, DAY_W - 4, ch).fillColor(cardBg).fill();
            // Left accent bar
            doc.rect(x + 2, cy, 2.5, ch).fillColor(accentColor).fill();

            // Discipline name (bold)
            const titleFontSize = ch >= 28 ? 8.5 : 7.5;
            const title = c.secondary_label
              ? `${c.discipline_name} \u2014 ${c.secondary_label}`
              : c.discipline_name;
            doc.fillColor(INK).font('Helvetica-Bold').fontSize(titleFontSize)
              .text(title, x + 6.5, cy + 2, { width: DAY_W - 10, lineBreak: false, ellipsis: true });

            // Second line: time + instructor
            if (ch >= 18) {
              const timeStr = `${(c.start_time || '').slice(0, 5)}\u2013${(c.end_time || '').slice(0, 5)}`;
              const infoLine = c.teacher_name ? `${timeStr} \u00b7 ${c.teacher_name}` : timeStr;
              doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(7)
                .text(infoLine, x + 6.5, cy + 2 + titleFontSize + 1.5, { width: DAY_W - 10, lineBreak: false, ellipsis: true });
            }

            // Third line: levels + location (if enough space)
            if (ch >= 28) {
              const levels = Array.isArray(c.practice_levels) && c.practice_levels.length
                ? c.practice_levels.join(', ') : '';
              const locTag = c.location_city || '';
              const thirdLine = [levels, locTag].filter(Boolean).join(' \u2022 ');
              if (thirdLine) {
                doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(6.5)
                  .text(thirdLine, x + 6.5, cy + 2 + titleFontSize + 1.5 + 6.5, { width: DAY_W - 10, lineBreak: false, ellipsis: true });
              }
            }
          });
        }

        // Vertical cell border
        doc.moveTo(x, rowY).lineTo(x, rowY + rh).strokeColor('#ddd8d2').lineWidth(0.3).stroke();
      });

      // Vertical borders: time col right + outer right
      doc.moveTo(MARGIN + TIME_W, rowY).lineTo(MARGIN + TIME_W, rowY + rh).strokeColor('#ddd8d2').lineWidth(0.3).stroke();
      doc.moveTo(MARGIN + CW, rowY).lineTo(MARGIN + CW, rowY + rh).strokeColor('#ddd8d2').lineWidth(0.3).stroke();
      // Horizontal row border
      doc.moveTo(MARGIN, rowY).lineTo(MARGIN + CW, rowY).strokeColor('#ddd8d2').lineWidth(0.3).stroke();

      rowY += rh;
    }
    // Bottom + outer borders
    doc.moveTo(MARGIN, rowY).lineTo(MARGIN + CW, rowY).strokeColor('#ddd8d2').lineWidth(0.3).stroke();
    doc.rect(MARGIN, GRID_Y, CW, GRID_H).strokeColor('#c8c4be').lineWidth(0.5).stroke();

    // Footer
    const totalClasses = classes.length;
    doc.fillColor(MUTED).font('Helvetica').fontSize(6.5)
      .text(`${totalClasses} cours \u2022 ${locationLabel} \u2022 ${saisonLabel} \u2022 G\u00e9n\u00e9r\u00e9 le ${now}`, MARGIN, PH - MARGIN - 9, { width: CW, align: 'center' });

    doc.end();
  } catch (err) {
    console.error('Error generating schedule PDF:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur g\u00e9n\u00e9ration PDF' });
  }
});

// ==========================================
// PDF: Contrat d'adhésion (formulaire vierge A4, 3 pages)
// ==========================================
app.get('/api/inscription/pdf', async (req, res) => {
  try {
    const [disciplinesRes, formulasRes, saisonsRes] = await Promise.all([
      pool.query('SELECT name FROM disciplines ORDER BY name'),
      pool.query('SELECT label, prix_cents, periodicite, description FROM formulas WHERE active = TRUE ORDER BY position'),
      pool.query('SELECT nom FROM saisons WHERE active = TRUE LIMIT 1')
    ]);

    const disciplines = disciplinesRes.rows;
    const formulas = formulasRes.rows;
    const saisonNom = (saisonsRes.rows[0] && saisonsRes.rows[0].nom) || '2025/2026';

    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="contrat-adhesion.pdf"');
    doc.pipe(res);

    // Constants
    const W = 595.28;
    const H = 841.89;
    const MARGIN = 46;
    const CW = W - MARGIN * 2;
    const GAP = 10;
    const HW = (CW - GAP) / 2;
    const TW = (CW - GAP * 2) / 3;
    const QW = (CW - GAP * 3) / 4;
    const INK = '#0a0a0a';
    const ROSE = '#c44d56';
    const MUTED = '#9a9a9a';
    const SLATE = '#555555';
    const FIELDBG = '#f5f3f0';
    const LIGHTBG = '#fafaf8';

    // ── Helpers ──────────────────────────────────────────────────────────────

    function drawPageHeader(pageLabel) {
      doc.rect(0, 0, W, 68).fill(INK);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
        .text("L'ACADÉMIE", MARGIN, 16, { width: CW });
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9.5)
        .text("Contrat d'adh\u00e9sion \u2014 Saison " + saisonNom, MARGIN, 42, { width: CW / 2 });
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9)
        .text(pageLabel, MARGIN, 42, { width: CW, align: 'right' });
    }

    function drawFooter(pageNum, total) {
      doc.moveTo(MARGIN, H - 30).lineTo(W - MARGIN, H - 30).strokeColor('#e0ddd9').lineWidth(0.5).stroke();
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
        .text("L\u2019Acad\u00e9mie Joseph-S\u00e9verac  \u2022  THERPSIKHOROS SAS  \u2022  Page " + pageNum + "/" + total, MARGIN, H - 22, { width: CW, align: 'center' });
    }

    function sectionLabel(label, y) {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8)
        .text(label.toUpperCase(), MARGIN, y, { width: CW, characterSpacing: 1.2 });
      return y + 16;
    }

    // Empty box with label — for handwriting
    function blankField(label, x, y, w, h) {
      h = h || 34;
      doc.rect(x, y, w, h).fillColor(FIELDBG).fill();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5)
        .text(label, x + 7, y + 6, { width: w - 14 });
    }

    // Small checkbox square + label
    function checkboxItem(label, x, y) {
      doc.rect(x, y, 10, 10).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
        .text(label, x + 14, y, {});
    }

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE 1 — Identité & Contact
    // ─────────────────────────────────────────────────────────────────────────
    doc.addPage();
    drawPageHeader('Page 1/3 \u2014 Identit\u00e9 & Contact');

    let y = 80;

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
      .text("Contrat d\u2019adh\u00e9sion", MARGIN, y, { width: CW });
    y += 20;
    doc.moveTo(MARGIN, y).lineTo(W - MARGIN, y).strokeColor('#e0ddd9').lineWidth(0.8).stroke();
    y += 12;

    // IDENTITÉ
    y = sectionLabel('Identit\u00e9', y);
    blankField('Pr\u00e9nom', MARGIN, y, HW);
    blankField('Nom', MARGIN + HW + GAP, y, HW);
    y += 40;
    blankField('Date de naissance', MARGIN, y, TW);
    blankField('Lieu de naissance', MARGIN + TW + GAP, y, TW);
    blankField('Nationalit\u00e9', MARGIN + (TW + GAP) * 2, y, TW);
    y += 40;

    // COORDONNÉES
    y = sectionLabel('Coordonn\u00e9es', y + 6);
    blankField('Adresse', MARGIN, y, CW);
    y += 40;
    blankField('Code postal', MARGIN, y, QW);
    blankField('Ville', MARGIN + QW + GAP, y, QW);
    blankField('T\u00e9l\u00e9phone', MARGIN + (QW + GAP) * 2, y, QW);
    blankField('Email', MARGIN + (QW + GAP) * 3, y, QW);
    y += 40;

    // RESPONSABLE LÉGAL
    y = sectionLabel('Responsable l\u00e9gal (si mineur)', y + 6);
    blankField('Nom & Pr\u00e9nom du responsable', MARGIN, y, HW);
    blankField('T\u00e9l\u00e9phone', MARGIN + HW + GAP, y, HW);
    y += 40;
    blankField('Email du responsable', MARGIN, y, CW);
    y += 40;

    // CONTACT D'URGENCE
    y = sectionLabel("Contact d\u2019urgence", y + 6);
    blankField('Nom & Pr\u00e9nom', MARGIN, y, TW);
    blankField('T\u00e9l\u00e9phone', MARGIN + TW + GAP, y, TW);
    blankField('Lien de parent\u00e9', MARGIN + (TW + GAP) * 2, y, TW);
    y += 40;

    // TAILLES
    y = sectionLabel('Tailles', y + 6);
    blankField('Taille haut', MARGIN, y, TW);
    blankField('Pointure', MARGIN + TW + GAP, y, TW);
    blankField('Taille bas', MARGIN + (TW + GAP) * 2, y, TW);
    y += 40;

    // RÉSERVES SANITAIRES
    y = sectionLabel('R\u00e9serves sanitaires / Traitements m\u00e9dicaux', y + 6);
    blankField('Allergies, traitements en cours, contre-indications m\u00e9dicales (ou \u00ab n\u00e9ant \u00bb)', MARGIN, y, CW, 54);
    y += 60;

    // SOURCE
    y = sectionLabel("Comment avez-vous connu L\u2019Acad\u00e9mie\u00a0?", y + 6);
    doc.rect(MARGIN, y, CW, 38).fillColor(FIELDBG).fill();
    const sources = ['Bouche \u00e0 oreille', 'R\u00e9seaux sociaux', 'Site web', 'Affichage', 'Autre'];
    const srcW = CW / sources.length;
    sources.forEach(function(src, i) {
      const cx = MARGIN + i * srcW + 10;
      const cy = y + 14;
      doc.rect(cx, cy, 10, 10).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(src, cx + 14, cy, {});
    });
    y += 44;

    drawFooter(1, 3);

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE 2 — Inscription & Engagement
    // ─────────────────────────────────────────────────────────────────────────
    doc.addPage();
    drawPageHeader('Page 2/3 \u2014 Inscription & Engagement');

    y = 80;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
      .text('Inscription & Engagement', MARGIN, y, { width: CW });
    y += 20;
    doc.moveTo(MARGIN, y).lineTo(W - MARGIN, y).strokeColor('#e0ddd9').lineWidth(0.8).stroke();
    y += 12;

    // INSCRIPTION — saison + site
    y = sectionLabel('Inscription', y);
    doc.rect(MARGIN, y, CW, 48).fillColor(FIELDBG).fill();
    // Saison
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5).text('Saison', MARGIN + 10, y + 7);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(12).text(saisonNom, MARGIN + 52, y + 4);
    // Site
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8).text('Site', MARGIN + 160, y + 7);
    doc.rect(MARGIN + 185, y + 5, 11, 11).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text('Arcachon', MARGIN + 200, y + 5);
    doc.rect(MARGIN + 285, y + 5, 11, 11).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text('Gujan-Mestras', MARGIN + 300, y + 5);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8)
      .text('Cocher le ou les sites fr\u00e9quent\u00e9s', MARGIN + 10, y + 32);
    y += 54;

    // DISCIPLINES
    y = sectionLabel('Discipline(s) choisie(s)', y + 4);
    const discCols = 3;
    const discColW = (CW - GAP * (discCols - 1)) / discCols;
    const discRowH = 27;
    const discRows = Math.ceil(disciplines.length / discCols) || 1;
    const discBoxH = discRows * discRowH + 10;
    doc.rect(MARGIN, y, CW, discBoxH).fillColor(FIELDBG).fill();
    disciplines.forEach(function(d, i) {
      const col = i % discCols;
      const row = Math.floor(i / discCols);
      const dx = MARGIN + col * (discColW + GAP) + 10;
      const dy = y + 8 + row * discRowH;
      doc.rect(dx, dy, 10, 10).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5).text(d.name, dx + 14, dy, {});
    });
    y += discBoxH + 6;

    // FORMULES TARIFAIRES
    y = sectionLabel('Formule tarifaire', y + 4);
    const fmtCols = 2;
    const fmtColW = (CW - GAP) / 2;
    const fmtRowH = 34;
    const fmtRows = Math.ceil(formulas.length / fmtCols) || 1;
    const fmtBoxH = fmtRows * fmtRowH + 8;
    doc.rect(MARGIN, y, CW, fmtBoxH).fillColor(FIELDBG).fill();
    formulas.forEach(function(f, i) {
      const col = i % fmtCols;
      const row = Math.floor(i / fmtCols);
      const fx = MARGIN + col * (fmtColW + GAP) + 10;
      const fy = y + 6 + row * fmtRowH;
      doc.rect(fx, fy, 10, 10).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
      const priceStr = f.prix_cents ? String(Math.round(f.prix_cents / 100)) + '\u20ac' : '';
      const periodStr = (f.periodicite && f.periodicite !== 'unique') ? '/' + f.periodicite : '';
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
        .text(f.label, fx + 14, fy, {});
      doc.fillColor(ROSE).font('Helvetica-Bold').fontSize(9)
        .text(priceStr + periodStr, fx + 14 + 140, fy, {});
      if (f.description) {
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(7.5)
          .text(f.description, fx + 14, fy + 13, { width: fmtColW - 32 });
      }
    });
    y += fmtBoxH + 6;

    // MODE DE PAIEMENT
    y = sectionLabel('Mode de paiement', y + 4);
    doc.rect(MARGIN, y, CW, 38).fillColor(FIELDBG).fill();
    const payModes = ['Ch\u00e8que', 'Esp\u00e8ces', 'Virement bancaire', 'Pr\u00e9l\u00e8vement'];
    payModes.forEach(function(pm, i) {
      const px = MARGIN + i * (CW / 4) + 14;
      const py = y + 14;
      doc.rect(px, py, 10, 10).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(pm, px + 14, py, {});
    });
    y += 44;

    // ADHÉSION
    y = sectionLabel('Adh\u00e9sion', y + 4);
    doc.rect(MARGIN, y, CW, 36).fillColor(FIELDBG).fill();
    doc.fillColor(ROSE).font('Helvetica-Bold').fontSize(12).text('25\u00a0\u20ac', MARGIN + 10, y + 7);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
      .text('Cotisation annuelle obligatoire, valable pour la saison en cours \u2014 \u00e0 r\u00e9gler lors de l\u2019inscription.', MARGIN + 56, y + 10, { width: CW - 66 });
    y += 42;

    // CERTIFICAT MÉDICAL
    y = sectionLabel('Certificat m\u00e9dical', y + 4);
    doc.rect(MARGIN, y, CW, 52).fillColor(FIELDBG).fill();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
      .text('Je m\u2019engage \u00e0 fournir un certificat m\u00e9dical de non contre-indication \u00e0 la pratique sportive.', MARGIN + 10, y + 9, { width: CW - 20 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
      .text('Date limite de remise\u00a0: \u00a0\u00a0_____ / _____ / __________', MARGIN + 10, y + 30);
    y += 58;

    drawFooter(2, 3);

    // ─────────────────────────────────────────────────────────────────────────
    // PAGE 3 — Consentements & Signature
    // ─────────────────────────────────────────────────────────────────────────
    doc.addPage();
    drawPageHeader('Page 3/3 \u2014 Consentements & Signature');

    y = 80;
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(15)
      .text('Consentements & Signature', MARGIN, y, { width: CW });
    y += 20;
    doc.moveTo(MARGIN, y).lineTo(W - MARGIN, y).strokeColor('#e0ddd9').lineWidth(0.8).stroke();
    y += 12;

    // DROIT À L'IMAGE
    y = sectionLabel('Droit \u00e0 l\u2019image', y);

    // Option J'autorise
    doc.rect(MARGIN, y, CW, 46).fillColor(FIELDBG).fill();
    doc.rect(MARGIN + 10, y + 18, 12, 12).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
      .text('J\u2019autorise L\u2019Acad\u00e9mie Joseph-S\u00e9verac \u00e0 utiliser mon image (ou celle de mon enfant) dans le cadre de ses activit\u00e9s\u00a0: spectacles, site web, r\u00e9seaux sociaux et supports de communication.', MARGIN + 28, y + 8, { width: CW - 40 });
    y += 52;

    // Option Je n'autorise PAS
    doc.rect(MARGIN, y, CW, 38).fillColor(LIGHTBG).fill();
    doc.rect(MARGIN + 10, y + 14, 12, 12).strokeColor('#bbbbbb').lineWidth(0.8).stroke();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
      .text('Je n\u2019autorise PAS l\u2019utilisation de mon image (ou celle de mon enfant) \u00e0 des fins de communication.', MARGIN + 28, y + 9, { width: CW - 40 });
    y += 44;

    // RGPD
    y = sectionLabel('Protection des donn\u00e9es personnelles (RGPD)', y + 6);

    const rgpdBoxTop = y;
    const rgpdBoxH = 288;
    doc.rect(MARGIN, y, CW, rgpdBoxH).fillColor('#f8f7f5').fill();
    // Left accent bar
    doc.moveTo(MARGIN + 3, y + 6).lineTo(MARGIN + 3, y + rgpdBoxH - 6)
      .strokeColor(ROSE).lineWidth(2).stroke();

    const rgpdX = MARGIN + 14;
    const rgpdW = CW - 24;
    let ry = y + 10;

    const rgpdSections = [
      { h: 'Responsable du traitement\u00a0:', b: 'THERPSIKHOROS SAS' },
      { h: 'R\u00e9f\u00e9rent RGPD\u00a0:', b: 'Gr\u00e9gory, Pr\u00e9sident' },
      { h: 'Finalit\u00e9s du traitement\u00a0:', b: 'Gestion des inscriptions, suivi p\u00e9dagogique et communication interne de Therpsikhoros SAS.' },
      { h: 'Dur\u00e9e de conservation\u00a0:', b: 'Les donn\u00e9es sont conserv\u00e9es pendant toute la dur\u00e9e de l\u2019inscription, puis pendant 3\u00a0ans suivant la derni\u00e8re saison d\u2019activit\u00e9.' },
      { h: 'Vos droits\u00a0:', b: 'Conform\u00e9ment au RGPD (UE)\u00a02016/679 et \u00e0 la loi \u00ab\u00a0Informatique et Libert\u00e9s\u00a0\u00bb, vous disposez d\u2019un droit d\u2019acc\u00e8s, de rectification, d\u2019effacement, de portabilit\u00e9, de limitation et d\u2019opposition au traitement de vos donn\u00e9es.' },
      { h: 'Exercice des droits\u00a0:', b: 'Pour exercer vos droits ou pour toute question relative \u00e0 vos donn\u00e9es personnelles, contactez le r\u00e9f\u00e9rent RGPD directement aupr\u00e8s du Pr\u00e9sident de Therpsikhoros SAS.' },
      { h: 'Consentement\u00a0:', b: 'La signature du pr\u00e9sent contrat vaut consentement au traitement des donn\u00e9es personnelles aux fins mentionn\u00e9es ci-dessus.' }
    ];

    for (var si = 0; si < rgpdSections.length; si++) {
      var s = rgpdSections[si];
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
        .text(s.h, rgpdX, ry, { width: rgpdW });
      ry = doc.y + 1;
      doc.fillColor(INK).font('Helvetica').fontSize(9)
        .text(s.b, rgpdX, ry, { width: rgpdW });
      ry = doc.y + 5;
    }

    y = rgpdBoxTop + rgpdBoxH + 6;

    // SIGNATURE
    y = sectionLabel('Signature', y + 4);
    doc.rect(MARGIN, y, CW, 148).fillColor(FIELDBG).fill();

    // Fait à __ le __
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
      .text('Fait \u00e0', MARGIN + 12, y + 14);
    doc.moveTo(MARGIN + 50, y + 24).lineTo(MARGIN + 210, y + 24)
      .strokeColor('#cccccc').lineWidth(0.6).stroke();
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
      .text('le', MARGIN + 218, y + 14);
    doc.moveTo(MARGIN + 232, y + 24).lineTo(MARGIN + 370, y + 24)
      .strokeColor('#cccccc').lineWidth(0.6).stroke();

    // Lu et approuvé
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10)
      .text('Lu et approuv\u00e9', MARGIN + 12, y + 42);

    // Signature zone
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5)
      .text('Signature du (de la) soussign\u00e9(e) — ou du repr\u00e9sentant l\u00e9gal si mineur', MARGIN + 12, y + 64);
    doc.moveTo(MARGIN + 12, y + 128).lineTo(MARGIN + 240, y + 128)
      .strokeColor('#aaaaaa').lineWidth(0.6).stroke();

    // Notes
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8)
      .text('Pour un mineur, signature du responsable l\u00e9gal obligatoire.', MARGIN + 12, y + 136, { width: 280 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(8)
      .text('Document \u00e9tabli par THERPSIKHOROS SAS', MARGIN + CW - 210, y + 136, { width: 210, align: 'right' });

    drawFooter(3, 3);

    doc.end();
  } catch (err) {
    console.error('Error generating inscription PDF:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Erreur g\u00e9n\u00e9ration PDF' });
  }
});

// ==========================================
// API: Saisons
// ==========================================

// List all saisons
app.get('/api/saisons', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM saisons ORDER BY date_debut DESC NULLS LAST, nom DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching saisons:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get active saison
app.get('/api/saisons/active', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM saisons WHERE active = TRUE LIMIT 1');
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('Error fetching active saison:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Get student's saisons (enriched with formula details + revenue projection)
app.get('/api/students/:id/saisons', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT
         ss.*,
         sa.nom, sa.date_debut, sa.date_fin, sa.active AS saison_active,
         f.label  AS formule_label,
         f.prix_cents  AS formule_prix_cents,
         f.periodicite AS formule_periodicite,
         f.montant_annuel_cents,
         CASE
           WHEN f.periodicite = 'mensuel' THEN
             GREATEST(1, LEAST(10,
               CASE
                 WHEN ss.date_resiliation IS NOT NULL
                   THEN EXTRACT(MONTH FROM AGE(ss.date_resiliation::date, sa.date_debut::date))::integer + 1
                 ELSE 10
               END
             ))
           WHEN f.periodicite LIKE '%unit%' THEN ss.cours_unite_count
           ELSE NULL
         END AS mois_effectifs,
         CASE
           WHEN f.periodicite = 'mensuel' THEN
             2500 + f.prix_cents * GREATEST(1, LEAST(10,
               CASE
                 WHEN ss.date_resiliation IS NOT NULL
                   THEN EXTRACT(MONTH FROM AGE(ss.date_resiliation::date, sa.date_debut::date))::integer + 1
                 ELSE 10
               END
             ))
           WHEN f.periodicite LIKE '%unit%' THEN 2500 + 1500 * ss.cours_unite_count
           WHEN f.periodicite = 'unique' THEN f.prix_cents
           ELSE NULL
         END AS revenu_effectif_cents
       FROM student_saisons ss
       JOIN saisons sa ON ss.saison_id = sa.id
       LEFT JOIN formulas f ON ss.formule_id = f.id
       WHERE ss.student_id = $1
       ORDER BY sa.date_debut DESC NULLS LAST`,
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching student saisons:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ==========================================
// API: Admin — Ré-import Google Sheets
// ==========================================

function fetchURL(url, maxRedirects = 5, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (maxRedirects === 0) return reject(new Error('Too many redirects'));
    const protocol = url.startsWith('https') ? https : require('http');
    const req = protocol.get(url, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
        return fetchURL(res.headers.location, maxRedirects - 1, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error('HTTP ' + res.statusCode + ' fetching ' + url));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('Timeout after ' + (timeoutMs / 1000) + 's fetching Google Sheets'));
    });
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function normalizeName(s) {
  return (s || '').toLowerCase().trim()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').trim();
}

app.post('/api/admin/reimport-sheets', async (req, res) => {
  const SHEET_ID = '1IrxZUYAeVX6xF3e4A9sXJeFVjuobszLK';
  const SHEET_NAME = 'PAIEMENTS';
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

  const report = {
    sheet: SHEET_NAME,
    columns_found: [],
    columns_missing: [],
    rows_processed: 0,
    students_matched: 0,
    students_updated: 0,
    students_not_found: [],
    saison_links_created: 0,
    errors: []
  };

  const EXPECTED_COLUMNS = ['Formule', 'MDP', 'Adresse', 'Code postal', 'Ville', 'Taille', 'Pointure'];
  const COLUMN_MAP = {
    'Formule': 'formule',
    'MDP': 'payment_method',
    'Adresse': 'address',
    'Code postal': 'postal_code',
    'CP': 'postal_code',
    'Ville': 'city',
    'Taille': 'size_top',
    'Pointure': 'shoe_size'
  };

  try {
    // Fetch active saison
    const saisonResult = await pool.query('SELECT id FROM saisons WHERE active = TRUE LIMIT 1');
    const activeSaisonId = saisonResult.rows[0] ? saisonResult.rows[0].id : null;

    // Fetch active formulas for matching
    const formulaResult = await pool.query('SELECT label FROM formulas WHERE active = TRUE');
    const formulaLabels = formulaResult.rows.map(r => r.label);

    // Fetch all active students for matching
    const studentsResult = await pool.query(
      'SELECT id, first_name, last_name, date_premiere_inscription FROM students WHERE active = TRUE'
    );
    const students = studentsResult.rows;

    // Fetch CSV from Google Sheets
    let csvData;
    try {
      csvData = await fetchURL(csvUrl);
    } catch (fetchErr) {
      return res.status(503).json({ error: 'Impossible de charger le Google Sheets', details: fetchErr.message });
    }

    const lines = csvData.split('\n').filter(l => l.trim());

    // Find header row (the one containing NOM and PRENOM)
    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const cols = parseCSVLine(lines[i]);
      const upperCols = cols.map(c => c.toUpperCase());
      if (upperCols.includes('NOM') && upperCols.includes('PRENOM')) {
        headerIdx = i;
        headers = cols.map(c => c.trim());
        break;
      }
    }

    if (headerIdx === -1) {
      return res.status(422).json({
        error: 'Colonne NOM/PRENOM introuvable dans la feuille',
        first_lines: lines.slice(0, 5)
      });
    }

    const nomIdx = headers.findIndex(h => h.toUpperCase() === 'NOM');
    const prenomIdx = headers.findIndex(h => h.toUpperCase() === 'PRENOM');

    // Map expected columns to their index
    const colIndexes = {};
    headers.forEach((h, i) => {
      if (COLUMN_MAP[h]) colIndexes[COLUMN_MAP[h]] = i;
    });

    // Track found/missing columns
    EXPECTED_COLUMNS.forEach(col => {
      const dbField = COLUMN_MAP[col];
      if (colIndexes[dbField] !== undefined) {
        if (!report.columns_found.includes(col)) report.columns_found.push(col);
      } else {
        report.columns_missing.push(col);
      }
    });

    // Build a lookup map of students by normalized name
    const studentMap = {};
    students.forEach(s => {
      const key = normalizeName(s.last_name) + '|' + normalizeName(s.first_name);
      if (!studentMap[key]) studentMap[key] = [];
      studentMap[key].push(s);
    });

    // Process data rows
    const dataRows = lines.slice(headerIdx + 1);
    for (const line of dataRows) {
      if (!line.trim()) continue;
      const cols = parseCSVLine(line);
      // Skip rows that look like summary/header rows
      if (!cols[nomIdx] || cols[nomIdx].toUpperCase() === 'NOM') continue;

      const rawNom = cols[nomIdx] || '';
      const rawPrenom = cols[prenomIdx] || '';
      if (!rawNom.trim()) continue;

      report.rows_processed++;

      // Match student — exact match first, then last-name-only fallback
      const lookupKey = normalizeName(rawNom) + '|' + normalizeName(rawPrenom);
      let matchedStudents = studentMap[lookupKey] || [];

      if (matchedStudents.length === 0) {
        // Try last_name only match (single result only to avoid ambiguity)
        const nomOnly = Object.keys(studentMap).filter(k => k.startsWith(normalizeName(rawNom) + '|'));
        if (nomOnly.length === 1) {
          matchedStudents = studentMap[nomOnly[0]] || [];
        }
      }

      if (matchedStudents.length === 0) {
        report.students_not_found.push(`${rawNom} ${rawPrenom}`);
        continue;
      }

      report.students_matched++;

      // Build update for each matched student
      for (const student of matchedStudents) {
        const updates = {};

        // Extract field values
        for (const [dbField, colIdx] of Object.entries(colIndexes)) {
          if (colIdx < cols.length) {
            const val = cols[colIdx] ? cols[colIdx].trim() : null;
            if (val) {
              if (dbField === 'formule') {
                // Try to match to known formula
                const normalized = normalizeName(val);
                const match = formulaLabels.find(l => normalizeName(l) === normalized);
                updates[dbField] = match || val;
              } else {
                updates[dbField] = val;
              }
            }
          }
        }

        // Set date_premiere_inscription if not set
        if (!student.date_premiere_inscription) {
          updates.date_premiere_inscription = new Date().toISOString().split('T')[0];
        }

        if (Object.keys(updates).length > 0) {
          const setClause = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
          const values = [student.id, ...Object.values(updates)];
          await pool.query(`UPDATE students SET ${setClause}, updated_at = NOW() WHERE id = $1`, values);
          report.students_updated++;
        }

        // Create saison link if active saison exists
        if (activeSaisonId) {
          const linkResult = await pool.query(
            `INSERT INTO student_saisons (student_id, saison_id, adhesion_payee)
             VALUES ($1, $2, TRUE)
             ON CONFLICT (student_id, saison_id) DO NOTHING
             RETURNING id`,
            [student.id, activeSaisonId]
          );
          if (linkResult.rows.length > 0) report.saison_links_created++;
        }
      }
    }

    res.json({ success: true, report });
  } catch (err) {
    console.error('Error in reimport-sheets:', err);
    res.status(500).json({ error: 'Erreur lors du ré-import', details: err.message });
  }
});

// Accept invitation / reset password page
app.get('/accept-invite', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'accept-invite.html'));
});

// Onboarding (profile completion on first login)
app.get('/onboarding', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
});

// Profile page (Mon profil — all roles)
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 2FA verify page
app.get('/verify-2fa', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verify-2fa.html'));
});

// Users management page (served but auth enforced in JS)
app.get('/users', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'users.html'));
});

// Dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// /crm → redirect to dashboard attendance view (backwards-compat alias)
app.get('/crm', (req, res) => {
  res.redirect('/dashboard?view=attendance');
});

// Tarifs / Pricing page
app.get('/tarifs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tarifs.html'));
});

// Migration Formules page (PRÉSIDENT only)
app.get('/admin/migration-formules', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-migration-formules.html'));
});

// Archives page
app.get('/archives', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'archives.html'));
});

// ==========================================
// API: Admin — Migration Formules (tâche #1362214)
// ==========================================

// Mapping: montant annuel (col D du PAIEMENTS) → formule + deux_cours_semaine
const MONTANT_TO_FORMULE = {
  275: { formule: 'Éveil et Initiation', deux_cours_semaine: false, confidence: 'auto' },
  295: { formule: 'Préparatoire',        deux_cours_semaine: false, confidence: 'auto' },
  325: { formule: 'Collectif standard',  deux_cours_semaine: false, confidence: 'auto' },
  565: { formule: 'Préparatoire',        deux_cours_semaine: true,  confidence: 'auto',
         note: '2 cours/semaine (Préparatoire × 2 : 25€ + 27€×10×2)' },
  595: { formule: 'Collectif standard',  deux_cours_semaine: true,  confidence: 'suggest',
         note: '2 cours/semaine mix Préparatoire+Collectif (57€/mois) — à confirmer' },
  625: { formule: 'Collectif standard',  deux_cours_semaine: true,  confidence: 'auto',
         note: '2 cours/semaine (Collectif × 2 : 25€ + 30€×10×2)' },
  725: { formule: 'Illimité solo',       deux_cours_semaine: false, confidence: 'auto' },
  950: { formule: 'Illimité famille',    deux_cours_semaine: false, confidence: 'auto',
         famille_nb: 2 },
  975: { formule: 'Illimité famille',    deux_cours_semaine: false, confidence: 'auto',
         famille_nb: 3 },
};

async function buildMigrationReport(dryRun) {
  const SHEET_ID = '1IrxZUYAeVX6xF3e4A9sXJeFVjuobszLK';
  const csvUrl = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=PAIEMENTS`;

  // Load current students
  const studentsResult = await pool.query(
    'SELECT id, first_name, last_name, formule, deux_cours_semaine FROM students WHERE active = TRUE'
  );
  const students = studentsResult.rows;

  // Build student lookup by normalized name
  function normName(s) {
    return s ? s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 -]/g, '').trim() : '';
  }
  const studentMap = {};
  students.forEach(s => {
    const key = normName(s.last_name) + '|' + normName(s.first_name);
    if (!studentMap[key]) studentMap[key] = [];
    studentMap[key].push(s);
  });
  const lastNameMap = {};
  students.forEach(s => {
    const key = normName(s.last_name);
    if (!lastNameMap[key]) lastNameMap[key] = [];
    lastNameMap[key].push(s);
  });

  // Fetch CSV
  let csvData;
  try {
    csvData = await fetchURL(csvUrl);
  } catch (e) {
    throw new Error('Impossible de charger le Google Sheets: ' + e.message);
  }

  const lines = csvData.split('\n').filter(l => l.trim());

  // Find header row
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const cols = parseCSVLine(lines[i]);
    const upper = cols.map(c => c.toUpperCase());
    if (upper.includes('NOM') && upper.includes('PRENOM')) { headerIdx = i; break; }
  }
  if (headerIdx === -1) throw new Error('Colonne NOM/PRENOM introuvable');

  const headers = parseCSVLine(lines[headerIdx]);
  const nomIdx    = headers.findIndex(h => h.toUpperCase() === 'NOM');
  const prenomIdx = headers.findIndex(h => h.toUpperCase() === 'PRENOM');
  // Detect the montant column dynamically: look for "A JOUR" (annual amount column)
  // Falls back to index 2 (col C, where the montant lives in the PAIEMENTS sheet)
  let montantIdx = headers.findIndex(h => h.toUpperCase().trim() === 'A JOUR');
  if (montantIdx === -1) montantIdx = 2;
  console.log('[migration-formules] CSV headers:', headers.slice(0, 6).join(', '), '| montantIdx:', montantIdx);

  // Parse all data rows into sheet entries
  const sheetRows = [];
  const dataLines = lines.slice(headerIdx + 1);
  for (const line of dataLines) {
    if (!line.trim()) continue;
    const cols = parseCSVLine(line);
    const nom    = (cols[nomIdx]    || '').trim();
    const prenom = (cols[prenomIdx] || '').trim();
    if (!nom || nom.toUpperCase() === 'NOM') continue;
    const montantRaw = (cols[montantIdx] || '').trim();
    const montant = montantRaw !== '' ? parseInt(montantRaw, 10) : null;
    sheetRows.push({ nom, prenom, montant });
  }

  const report = {
    total_sheet_rows:  sheetRows.length,
    auto_updated:      [],   // clear mapping, applied
    suggested:         [],   // soft mapping, needs confirm
    famille_groupes_created: [],
    famille_benef_flagged:   [],
    not_found:         [],   // name not in DB
    no_montant:        [],   // empty col D, not a known family bénéficiaire
    already_done:      [],   // formule already set
    errors:            [],
    stats: { total_auto: 0, total_suggest: 0, total_famille: 0, total_not_found: 0, total_manual: 0 }
  };

  // First pass: identify Illimité famille blocks (titulaire + bénéficiaires by proximity + same last name)
  const familleBlocks = []; // { titulaire_row_idx, benef_row_idxs: [], famille_nb }
  const rowIsAssignedToFamille = new Set();

  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    if (row.montant === null || !MONTANT_TO_FORMULE[row.montant]) continue;
    const mapping = MONTANT_TO_FORMULE[row.motant] || MONTANT_TO_FORMULE[row.montant];
    if (!mapping || !mapping.famille_nb) continue;

    const nb = mapping.famille_nb; // 2 or 3
    const benefs = [];
    // Look at surrounding rows (±5) with same last name and null montant
    for (let j = Math.max(0, i - 5); j < Math.min(sheetRows.length, i + 8) && benefs.length < nb - 1; j++) {
      if (j === i || rowIsAssignedToFamille.has(j)) continue;
      const r = sheetRows[j];
      if (r.montant !== null && r.montant !== 0) continue; // not a bénéficiaire if they have their own amount (except 0)
      if (normName(r.nom) === normName(row.nom)) {
        benefs.push(j);
      }
    }
    familleBlocks.push({ titulaire_row_idx: i, benef_row_idxs: benefs, famille_nb: nb });
    rowIsAssignedToFamille.add(i);
    benefs.forEach(j => rowIsAssignedToFamille.add(j));
  }

  // Process each sheet row
  for (let i = 0; i < sheetRows.length; i++) {
    const row = sheetRows[i];
    const { nom, prenom, montant } = row;

    // Match to DB student
    const exactKey = normName(nom) + '|' + normName(prenom);
    let matched = studentMap[exactKey] || [];
    if (matched.length === 0) {
      // Last name only fallback
      const keys = Object.keys(studentMap).filter(k => k.startsWith(normName(nom) + '|'));
      if (keys.length === 1) matched = studentMap[keys[0]] || [];
    }

    if (matched.length === 0) {
      report.not_found.push({ nom, prenom, montant });
      report.stats.total_not_found++;
      continue;
    }

    const student = matched[0];

    // Check if student is a bénéficiaire in a famille block (handled separately)
    const isBenef = familleBlocks.some(b => b.benef_row_idxs.includes(i));
    if (isBenef) continue; // handled in famille block processing

    // Check if this student is a titulaire in a famille block
    const familleBlock = familleBlocks.find(b => b.titulaire_row_idx === i);

    if (montant === null || montant === 0) {
      // Empty montant, not a titulaire or known bénéficiaire → manual review
      report.no_montant.push({ id: student.id, nom: student.last_name, prenom: student.first_name });
      report.stats.total_manual++;
      continue;
    }

    const mapping = MONTANT_TO_FORMULE[montant];
    if (!mapping) {
      // Unknown amount → manual review
      report.suggested.push({
        id: student.id,
        nom: student.last_name,
        prenom: student.first_name,
        montant,
        reason: `Montant ${montant}€ non reconnu automatiquement — à vérifier manuellement`
      });
      report.stats.total_suggest++;
      continue;
    }

    // Already has formule?
    if (student.formule === mapping.formule && student.deux_cours_semaine === mapping.deux_cours_semaine) {
      report.already_done.push({ id: student.id, nom: student.last_name, prenom: student.first_name, formule: mapping.formule });
      continue;
    }

    if (mapping.confidence === 'auto') {
      if (!dryRun) {
        try {
          await pool.query(
            `UPDATE students SET formule = $1, deux_cours_semaine = $2, updated_at = NOW() WHERE id = $3`,
            [mapping.formule, mapping.deux_cours_semaine, student.id]
          );
        } catch (e) {
          report.errors.push({ id: student.id, nom, prenom, error: e.message });
          continue;
        }
      }
      report.auto_updated.push({
        id: student.id, nom: student.last_name, prenom: student.first_name,
        formule: mapping.formule,
        deux_cours_semaine: mapping.deux_cours_semaine,
        montant,
        note: mapping.note || null
      });
      report.stats.total_auto++;
    } else {
      // suggest
      report.suggested.push({
        id: student.id,
        nom: student.last_name,
        prenom: student.first_name,
        montant,
        formule_suggested: mapping.formule,
        deux_cours_semaine_suggested: mapping.deux_cours_semaine,
        reason: mapping.note || 'Confirmation recommandée'
      });
      report.stats.total_suggest++;
    }

    // Handle famille block if titulaire
    if (familleBlock) {
      const benefs = [];
      let missingBenefs = 0;
      for (const j of familleBlock.benef_row_idxs) {
        const br = sheetRows[j];
        const bKey = normName(br.nom) + '|' + normName(br.prenom);
        let bMatched = studentMap[bKey] || [];
        if (bMatched.length === 0) {
          const bKeys = Object.keys(studentMap).filter(k => k.startsWith(normName(br.nom) + '|'));
          if (bKeys.length === 1) bMatched = studentMap[bKeys[0]] || [];
        }
        if (bMatched.length === 0) {
          missingBenefs++;
          report.not_found.push({ nom: br.nom, prenom: br.prenom, montant: br.montant, context: 'bénéficiaire famille' });
        } else {
          benefs.push(bMatched[0]);
        }
      }

      const expectedBenefCount = familleBlock.famille_nb - 1;
      if (!dryRun && benefs.length > 0) {
        try {
          // Check if groupe already exists
          const existingGroupe = await pool.query(
            'SELECT id FROM famille_groupes WHERE titulaire_student_id = $1', [student.id]
          );
          let groupeId;
          if (existingGroupe.rows.length > 0) {
            groupeId = existingGroupe.rows[0].id;
          } else {
            const newGroupe = await pool.query(
              'INSERT INTO famille_groupes (titulaire_student_id) VALUES ($1) RETURNING id', [student.id]
            );
            groupeId = newGroupe.rows[0].id;
          }
          for (const b of benefs) {
            await pool.query(
              `INSERT INTO famille_beneficiaires (groupe_id, beneficiaire_student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [groupeId, b.id]
            );
            if (b.formule !== 'Illimité famille') {
              await pool.query(
                `UPDATE students SET formule = 'Illimité famille', updated_at = NOW() WHERE id = $1`, [b.id]
              );
            }
          }
        } catch (e) {
          report.errors.push({ id: student.id, nom, prenom, error: 'famille: ' + e.message });
        }
      }

      const familleEntry = {
        titulaire_id: student.id,
        titulaire_nom: student.last_name,
        titulaire_prenom: student.first_name,
        montant,
        famille_nb: familleBlock.famille_nb,
        benefs_trouvés: benefs.map(b => ({ id: b.id, nom: b.last_name, prenom: b.first_name })),
        benefs_manquants: missingBenefs
      };

      if (missingBenefs > 0 || benefs.length < expectedBenefCount) {
        report.famille_benef_flagged.push({
          ...familleEntry,
          reason: `${missingBenefs} bénéficiaire(s) introuvable(s) dans la base`
        });
        report.stats.total_manual++;
      } else {
        report.famille_groupes_created.push(familleEntry);
        report.stats.total_famille++;
      }
    }
  }

  return report;
}

// Preview (dry run) — read only
app.get('/api/admin/migration-formules/preview', requireAuth(['PRÉSIDENT']), async (req, res) => {
  console.log('[migration-formules] Preview requested by', req.user.email);
  try {
    const report = await buildMigrationReport(true);
    console.log('[migration-formules] Preview OK — auto:', report.stats.total_auto, 'suggest:', report.stats.total_suggest, 'rows:', report.total_sheet_rows);
    res.json({ success: true, mode: 'preview', report });
  } catch (err) {
    console.error('[migration-formules] Preview ERROR:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Execute migration
app.post('/api/admin/migration-formules/run', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const report = await buildMigrationReport(false);
    // Store report
    await pool.query(
      `INSERT INTO formule_migration_report (run_by, mode, report) VALUES ($1, 'run', $2)`,
      [req.user.email, JSON.stringify(report)]
    );
    if (req.user) await logAudit(req.user.id, req.user.email, req.user.role, 'MIGRATION_FORMULES_RUN', 'students', null, {
      total_auto: report.stats.total_auto,
      total_famille: report.stats.total_famille
    }, req.ip);
    res.json({ success: true, mode: 'run', report });
  } catch (err) {
    console.error('Migration run error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get latest stored report
app.get('/api/admin/migration-formules/last-report', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, run_at, run_by, mode, report FROM formule_migration_report ORDER BY run_at DESC LIMIT 1`
    );
    if (result.rows.length === 0) return res.json({ report: null });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// SANTE DE LA BASE — Page route + API
// ==========================================

app.get('/sante-base', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sante-base.html'));
});

// Messagerie CRM — interface segmentation, composition, historique
app.get('/messagerie', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'messagerie.html'));
});

// Fiche des prix — grille tarifaire officielle
app.get('/fiche-prix', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'fiche-prix.html'));
});

// PWA Tablette — Appel des élèves (stylet uniquement)
app.get('/appel', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'appel.html'));
});

app.get('/api/diagnostic/sante-base', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
  try {
    // Resolve saison
    let saisonId = req.query.saison_id ? parseInt(req.query.saison_id) : null;
    const saisonsResult = await pool.query('SELECT id, nom, active FROM saisons ORDER BY id DESC');
    const saisons = saisonsResult.rows;
    if (!saisonId) {
      const active = saisons.find(s => s.active);
      saisonId = active ? active.id : (saisons[0] ? saisons[0].id : null);
    }
    if (!saisonId) return res.json({ error: 'Aucune saison trouvée' });

    // ---- TOTAL BASE (students enrolled this saison) ----
    const totalResult = await pool.query(
      `SELECT COUNT(DISTINCT s.id) as total
       FROM students s
       JOIN student_saisons ss ON ss.student_id = s.id AND ss.saison_id = $1
       WHERE s.active = true`,
      [saisonId]
    );
    const total = parseInt(totalResult.rows[0].total) || 0;

    // ---- SECTION 1: REPARTITIONS ----

    // 1a. Par formule (via student_saisons + formulas)
    const formuleResult = await pool.query(
      `SELECT COALESCE(f.label, s.formule, 'Non renseignée') as formule, COUNT(*) as count
       FROM students s
       JOIN student_saisons ss ON ss.student_id = s.id AND ss.saison_id = $1
       LEFT JOIN formulas f ON f.id = ss.formule_id
       WHERE s.active = true
       GROUP BY COALESCE(f.label, s.formule, 'Non renseignée')
       ORDER BY count DESC`,
      [saisonId]
    );

    // 1b. Par site (via disciplines inscrites → classes → locations)
    const siteResult = await pool.query(
      `WITH student_locs AS (
         SELECT DISTINCT sd.student_id, l.city
         FROM student_disciplines sd
         JOIN classes c ON c.discipline_id = sd.discipline_id AND c.active = true
         JOIN locations l ON c.location_id = l.id
         JOIN student_saisons ss ON ss.student_id = sd.student_id AND ss.saison_id = $1
         JOIN students s ON s.id = sd.student_id AND s.active = true
       ),
       student_site_agg AS (
         SELECT student_id,
           bool_or(city ILIKE '%arcachon%') AS in_arcachon,
           bool_or(city ILIKE '%gujan%') AS in_gujan
         FROM student_locs
         GROUP BY student_id
       ),
       enrolled AS (
         SELECT DISTINCT s.id
         FROM students s
         JOIN student_saisons ss ON ss.student_id = s.id AND ss.saison_id = $1
         WHERE s.active = true
       )
       SELECT
         COUNT(CASE WHEN ssa.in_arcachon AND NOT ssa.in_gujan THEN 1 END) as arcachon_only,
         COUNT(CASE WHEN ssa.in_gujan AND NOT ssa.in_arcachon THEN 1 END) as gujan_only,
         COUNT(CASE WHEN ssa.in_arcachon AND ssa.in_gujan THEN 1 END) as both_sites,
         COUNT(e.id) - COUNT(ssa.student_id) as non_assigne
       FROM enrolled e
       LEFT JOIN student_site_agg ssa ON ssa.student_id = e.id`,
      [saisonId]
    );

    // 1c. Par discipline
    const discResult = await pool.query(
      `SELECT d.name as discipline, COUNT(DISTINCT sd.student_id) as count
       FROM student_disciplines sd
       JOIN disciplines d ON d.id = sd.discipline_id
       JOIN student_saisons ss ON ss.student_id = sd.student_id AND ss.saison_id = $1
       JOIN students s ON s.id = sd.student_id AND s.active = true
       GROUP BY d.name
       ORDER BY count DESC`,
      [saisonId]
    );

    // 1d. Par tranche d'âge
    const ageResult = await pool.query(
      `SELECT
         COUNT(CASE WHEN EXTRACT(YEAR FROM AGE(NOW(), s.birth_date)) BETWEEN 3 AND 6 THEN 1 END) as age_3_6,
         COUNT(CASE WHEN EXTRACT(YEAR FROM AGE(NOW(), s.birth_date)) BETWEEN 7 AND 12 THEN 1 END) as age_7_12,
         COUNT(CASE WHEN EXTRACT(YEAR FROM AGE(NOW(), s.birth_date)) BETWEEN 13 AND 17 THEN 1 END) as age_13_17,
         COUNT(CASE WHEN EXTRACT(YEAR FROM AGE(NOW(), s.birth_date)) >= 18 THEN 1 END) as age_18_plus,
         COUNT(CASE WHEN s.birth_date IS NULL THEN 1 END) as age_unknown
       FROM students s
       JOIN student_saisons ss ON ss.student_id = s.id AND ss.saison_id = $1
       WHERE s.active = true`,
      [saisonId]
    );

    // 1e. Adhésion payée
    const adhesionResult = await pool.query(
      `SELECT
         COUNT(CASE WHEN ss.adhesion_payee = true THEN 1 END) as payee,
         COUNT(CASE WHEN ss.adhesion_payee = false OR ss.adhesion_payee IS NULL THEN 1 END) as non_payee
       FROM students s
       JOIN student_saisons ss ON ss.student_id = s.id AND ss.saison_id = $1
       WHERE s.active = true`,
      [saisonId]
    );

    // ---- SECTION 2: COMPLETUDE ----
    const completudeResult = await pool.query(
      `SELECT
         COUNT(*) as total,
         COUNT(CASE WHEN s.email IS NOT NULL AND s.email != '' THEN 1 END) as email,
         COUNT(CASE WHEN s.phone IS NOT NULL AND s.phone != '' THEN 1 END) as phone,
         COUNT(CASE WHEN s.birth_date IS NOT NULL THEN 1 END) as birth_date,
         COUNT(CASE WHEN (s.address IS NOT NULL AND s.address != '') OR (s.postal_code IS NOT NULL AND s.postal_code != '') THEN 1 END) as adresse,
         COUNT(CASE WHEN (ss.formule_id IS NOT NULL) OR (s.formule IS NOT NULL AND s.formule != '') THEN 1 END) as formule,
         COUNT(CASE WHEN ss.adhesion_payee IS NOT NULL THEN 1 END) as adhesion,
         COUNT(CASE WHEN s.numero_adherent IS NOT NULL AND s.numero_adherent != '' THEN 1 END) as numero_adherent
       FROM students s
       JOIN student_saisons ss ON ss.student_id = s.id AND ss.saison_id = $1
       WHERE s.active = true`,
      [saisonId]
    );

    const c = completudeResult.rows[0];
    const tot = parseInt(c.total) || 0;

    const fields = [
      { key: 'email', label: 'Email', renseignees: parseInt(c.email), total: tot },
      { key: 'phone', label: 'Téléphone', renseignees: parseInt(c.phone), total: tot },
      { key: 'birth_date', label: 'Date de naissance', renseignees: parseInt(c.birth_date), total: tot },
      { key: 'adresse', label: 'Adresse postale', renseignees: parseInt(c.adresse), total: tot },
      { key: 'formule', label: 'Formule attribuée', renseignees: parseInt(c.formule), total: tot },
      { key: 'adhesion', label: 'Adhésion payée (renseignée)', renseignees: parseInt(c.adhesion), total: tot },
      { key: 'numero_adherent', label: 'Numéro d\'adhérent', renseignees: parseInt(c.numero_adherent), total: tot },
    ].map(f => ({
      ...f,
      manquantes: f.total - f.renseignees,
      pct: f.total > 0 ? Math.round((f.renseignees / f.total) * 100) : 0
    })).sort((a, b) => a.renseignees - b.renseignees); // most missing first

    // ---- SECTION 3: SCORE GLOBAL ----
    // "Fiche complète" = tous les champs clés renseignés
    const scoreResult = await pool.query(
      `SELECT COUNT(*) as fiches_completes
       FROM students s
       JOIN student_saisons ss ON ss.student_id = s.id AND ss.saison_id = $1
       WHERE s.active = true
         AND s.email IS NOT NULL AND s.email != ''
         AND s.phone IS NOT NULL AND s.phone != ''
         AND s.birth_date IS NOT NULL
         AND (s.address IS NOT NULL AND s.address != '' OR s.postal_code IS NOT NULL AND s.postal_code != '')
         AND (ss.formule_id IS NOT NULL OR (s.formule IS NOT NULL AND s.formule != ''))
         AND ss.adhesion_payee IS NOT NULL
         AND s.numero_adherent IS NOT NULL AND s.numero_adherent != ''`,
      [saisonId]
    );
    const fichesCompletes = parseInt(scoreResult.rows[0].fiches_completes) || 0;

    res.json({
      saison_id: saisonId,
      saisons,
      total,
      repartitions: {
        par_formule: formuleResult.rows.map(r => ({
          label: r.formule,
          count: parseInt(r.count),
          pct: total > 0 ? Math.round((parseInt(r.count) / total) * 100) : 0
        })),
        par_site: {
          arcachon_only: parseInt(siteResult.rows[0].arcachon_only) || 0,
          gujan_only: parseInt(siteResult.rows[0].gujan_only) || 0,
          both_sites: parseInt(siteResult.rows[0].both_sites) || 0,
          non_assigne: parseInt(siteResult.rows[0].non_assigne) || 0,
        },
        par_discipline: discResult.rows.map(r => ({
          label: r.discipline,
          count: parseInt(r.count),
          pct: total > 0 ? Math.round((parseInt(r.count) / total) * 100) : 0
        })),
        par_age: {
          '3-6 ans': { count: parseInt(ageResult.rows[0].age_3_6) || 0, pct: total > 0 ? Math.round(((parseInt(ageResult.rows[0].age_3_6) || 0) / total) * 100) : 0 },
          '7-12 ans': { count: parseInt(ageResult.rows[0].age_7_12) || 0, pct: total > 0 ? Math.round(((parseInt(ageResult.rows[0].age_7_12) || 0) / total) * 100) : 0 },
          '13-17 ans': { count: parseInt(ageResult.rows[0].age_13_17) || 0, pct: total > 0 ? Math.round(((parseInt(ageResult.rows[0].age_13_17) || 0) / total) * 100) : 0 },
          '18+ adultes': { count: parseInt(ageResult.rows[0].age_18_plus) || 0, pct: total > 0 ? Math.round(((parseInt(ageResult.rows[0].age_18_plus) || 0) / total) * 100) : 0 },
          'Âge inconnu': { count: parseInt(ageResult.rows[0].age_unknown) || 0, pct: total > 0 ? Math.round(((parseInt(ageResult.rows[0].age_unknown) || 0) / total) * 100) : 0 },
        },
        adhesion: {
          payee: parseInt(adhesionResult.rows[0].payee) || 0,
          non_payee: parseInt(adhesionResult.rows[0].non_payee) || 0,
          pct_payee: total > 0 ? Math.round(((parseInt(adhesionResult.rows[0].payee) || 0) / total) * 100) : 0
        }
      },
      completude: {
        fields,
        note: 'Pas de champ "certificat médical" en base actuellement'
      },
      score: {
        fiches_completes: fichesCompletes,
        fiches_incompletes: total - fichesCompletes,
        pct_complet: total > 0 ? Math.round((fichesCompletes / total) * 100) : 0
      }
    });
  } catch (err) {
    console.error('[sante-base] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// TABLET PIN AUTH
// ==========================================

// POST /api/pin/auth — verify PIN, issue 30-day tablet session
// Public endpoint — no CRM credentials needed
app.post('/api/pin/auth', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4,6}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN invalide' });
    }
    // Fetch all active PINs and compare hashes
    const result = await pool.query(
      `SELECT id, pin_hash FROM tablet_pins WHERE active = true`
    );
    let matched = null;
    for (const row of result.rows) {
      const ok = await bcrypt.compare(String(pin), row.pin_hash);
      if (ok) { matched = row; break; }
    }
    if (!matched) {
      return res.status(401).json({ error: 'Code PIN incorrect' });
    }
    // Issue 30-day tablet session
    const rawToken = generateToken(32);
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO tablet_sessions (pin_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [matched.id, tokenHash, expiresAt]
    );
    res.json({ token: rawToken });
  } catch (err) {
    console.error('[pin/auth] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pin/verify — validate tablet session token
// Public endpoint — called by /appel on load
app.get('/api/pin/verify', async (req, res) => {
  try {
    const rawToken = getRequestToken(req);
    if (!rawToken) return res.status(401).json({ error: 'Non authentifié' });
    const tokenHash = hashToken(rawToken);
    const result = await pool.query(
      `SELECT ts.id FROM tablet_sessions ts
       JOIN tablet_pins tp ON tp.id = ts.pin_id
       WHERE ts.token_hash = $1 AND ts.expires_at > NOW() AND tp.active = true`,
      [tokenHash]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: 'Session expirée ou révoquée' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[pin/verify] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/pins — list active PINs (PRÉSIDENT only)
app.get('/api/admin/pins', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, label, active, created_at, revoked_at FROM tablet_pins ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[admin/pins] GET Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/pins — create a new PIN (PRÉSIDENT only)
app.post('/api/admin/pins', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const { label, pin } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'Libellé requis' });
    if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN doit être 4 à 6 chiffres' });
    const pinHash = await bcrypt.hash(String(pin), 10);
    const result = await pool.query(
      `INSERT INTO tablet_pins (label, pin_hash, created_by) VALUES ($1, $2, $3) RETURNING id, label, active, created_at`,
      [label.trim(), pinHash, req.user.id]
    );
    await logAudit(req.user.id, req.user.email, req.user.role, 'CREATE_TABLET_PIN', 'tablet_pins', result.rows[0].id, { label: label.trim() }, req.ip);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[admin/pins] POST Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/pins/:id — revoke PIN (PRÉSIDENT only)
// Revocation invalidates all tablet sessions for that PIN
app.delete('/api/admin/pins/:id', requireAuth(['PRÉSIDENT']), async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE tablet_pins SET active = false, revoked_at = NOW() WHERE id = $1 AND active = true RETURNING id, label`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'PIN introuvable ou déjà révoqué' });
    // Delete all active sessions for this PIN
    await pool.query(`DELETE FROM tablet_sessions WHERE pin_id = $1`, [id]);
    await logAudit(req.user.id, req.user.email, req.user.role, 'REVOKE_TABLET_PIN', 'tablet_pins', id, { label: result.rows[0].label }, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/pins] DELETE Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/diag/email — test Resend email connectivity (debug only, no auth)
app.get('/api/diag/email', async (req, res) => {
  const result = {
    provider: 'resend',
    resendKeyConfigured: !!process.env.RESEND_API_KEY,
    fromEmail: process.env.FROM_EMAIL || 'contact@lacademie.art',
    testedAt: new Date().toISOString(),
  };
  try {
    await sendEmail(
      process.env.DIAG_EMAIL_TO || 'gregjs33260@gmail.com',
      '[DIAG] AcadémieOS — Resend email test',
      'This diagnostic email confirms that Resend email sending is working correctly.\n\n— AcadémieOS'
    );
    result.success = true;
    console.log('[email-diag] PASS — Resend email sent');
  } catch (err) {
    result.success = false;
    result.error = err.message;
    console.log('[email-diag] FAIL — Resend error:', err.message);
  }
  res.json(result);
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
