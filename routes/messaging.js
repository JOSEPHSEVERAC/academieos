// routes/messaging.js
// Owns: email campaign lifecycle (compose, validation circuit, batch send, history, open tracking).
// Does NOT own: student CRUD, auth sessions, attendance, famille groups, CRM user management.
//
// Validation circuit:
//   PRÉSIDENT  → envoi direct (no validation needed)
//   DIRECTRICE → soumission → notification PRÉSIDENT → approbation → envoi
//   PROFESSEUR → soumission → notification DIRECTRICE → approbation → envoi
//
// Rejection → brouillon renvoyé à l'auteur (email notif).
// Validator may optionally add their own signature when approving.

const express = require('express');

// ── Static identities (real names, non-configurable) ─────────────────────────
// Grégory JOSEPH-SÉVERAC is the Président of THERPSIKHOROS SAS. Anne-Lise BRICOGNE
// is the Directrice of L'Académie. These appear in the bi-column signature block.
const PRESIDENT_NAME    = 'Grégory JOSEPH-SÉVERAC';
const PRESIDENT_ROLE    = 'Président, THERPSIKHOROS SAS';
const DIRECTRICE_NAME   = 'Anne-Lise BRICOGNE';
const DIRECTRICE_ROLE   = 'Directrice, L\'Académie';

// Logo URL — black logo on white background (PNG, served from R2)
const LOGO_URL = 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_98213/images/c14f688c-4f74-46d3-a097-a49cda1d65ec.png';

// ── Email template builder ────────────────────────────────────────────────────
// Builds the definitive transactional HTML template:
//   Header    : L'Académie logo (transparent, floats on white)
//   Body      : author's composed HTML
//   Brand bloc: logo + « Avec ou sans pointes » + 1965
//   Signatures: bi-column (left = operational, right = Président if applicable)
//   Legal      : THERPSIKHOROS SAS coordinates
//   RGPD       : unsubscribe link
//
// signatureLeft  = array of { name, role } objects stacked top→bottom
// signatureRight = { name, role } | null
function buildEmailTemplate({ bodyHtml, signatureLeft = [], signatureRight = null, pixelUrl, unsubUrl }) {
  // Render left-column signature rows (may be stacked: e.g. professeur + directrice)
  const leftRows = signatureLeft.map(s =>
    `<div style="margin-bottom:10px">
       <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#0a0a0a">${s.name}</div>
       <div style="font-family:Arial,sans-serif;font-size:13px;color:#555555">${s.role}</div>
     </div>`
  ).join('');

  // Render right-column signature (Président, if present)
  const rightCol = signatureRight
    ? `<td style="padding:0 0 0 24px;border-left:1px solid #ece8e3;vertical-align:top;width:50%">
         <div style="font-family:Arial,sans-serif;font-size:14px;font-weight:700;color:#0a0a0a">${signatureRight.name}</div>
         <div style="font-family:Arial,sans-serif;font-size:13px;color:#555555">${signatureRight.role}</div>
       </td>`
    : '<td style="width:50%"></td>';

  // Only render the signature row if there's anything to show
  const hasSignature = signatureLeft.length > 0 || signatureRight !== null;
  const signatureSection = hasSignature ? `
      <!-- Signatures bi-colonne -->
      <tr>
        <td style="padding:28px 40px 0">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="vertical-align:top;width:50%;padding-right:24px">
                ${leftRows}
              </td>
              ${rightCol}
            </tr>
          </table>
        </td>
      </tr>` : '';

  const pixel = pixelUrl
    ? `<img src="${pixelUrl}" width="1" height="1" style="display:none;border:0" alt="" />`
    : '';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,400&display=swap');
  body { margin:0; padding:0; background:#f5f5f5; font-family:Arial,Helvetica,sans-serif; }
  table { border-collapse:collapse; }
</style>
</head>
<body>
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08)">

      <!-- Header : logo sur fond blanc (transparent PNG — le logo flotte) -->
      <tr>
        <td align="center" style="background:#ffffff;padding:32px 20px 24px">
          <img src="${LOGO_URL}" alt="L'Académie" width="140" style="max-width:140px;height:auto;display:block;margin:0 auto">
        </td>
      </tr>

      <!-- Corps du message -->
      <tr>
        <td style="padding:0 40px 28px;font-family:Arial,sans-serif;font-size:15px;line-height:1.7;color:#333333">
          ${bodyHtml}
        </td>
      </tr>

      ${signatureSection}

      <!-- Bloc marque centré — spec verrouillée : logo + slogan Cormorant Garamond + 1965, noir sur blanc -->
      <tr>
        <td align="center" style="padding:32px 40px 28px;border-top:1px solid #e0e0e0">
          <img src="${LOGO_URL}" alt="L'Académie" width="80" style="max-width:80px;height:auto;display:block;margin:0 auto 12px">
          <div style="font-family:'Cormorant Garamond',Georgia,'Times New Roman',serif;font-size:18px;color:#000000;font-style:italic;letter-spacing:0.02em;margin-bottom:8px">&#171;&#8201;Avec ou sans pointes&#8201;&#187;</div>
          <div style="font-family:Arial,sans-serif;font-size:12px;color:#000000;letter-spacing:0.12em">1965</div>
        </td>
      </tr>

      <!-- Mentions légales -->
      <tr>
        <td align="center" style="background:#f9f9f9;padding:20px 40px;border-top:1px solid #ece8e3">
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#9ca3af;line-height:1.8">
            THERPSIKHOROS SAS<br>
            24 rue Paul Pouget — 33470 Gujan-Mestras<br>
            SIRET 833 749 344 00028 · Tél. 05 56 54 45 51<br>
            <a href="https://lacademie.eu" style="color:#9ca3af;text-decoration:none">lacademie.eu</a>
            · <a href="mailto:contact@lacademie.eu" style="color:#9ca3af;text-decoration:none">contact@lacademie.eu</a>
          </div>
        </td>
      </tr>

      <!-- Lien RGPD -->
      <tr>
        <td align="center" style="padding:12px 40px 24px;background:#f9f9f9">
          <div style="font-family:Arial,sans-serif;font-size:11px;color:#9ca3af">
            Vous recevez cet email car vous êtes inscrit(e) à L'Académie.
            <a href="${unsubUrl}" style="color:#9ca3af;text-decoration:underline">Se désinscrire</a>
          </div>
          ${pixel}
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Resolve signatures for a campaign ────────────────────────────────────────
// Returns { signatureLeft, signatureRight } based on who composed and who validated.
//
// Rules (from spec):
//   Président envoie              → left=[], right=Président
//   Directrice + sig Président    → left=[Directrice], right=Président
//   Directrice seule              → left=[Directrice], right=null
//   Professeur + sig Directrice   → left=[Professeur, Directrice], right=null
//   Professeur seul               → left=[Professeur], right=null
//   Email auto (no author)        → left=[L'Académie Direction], right=Président
function resolveSignatures({ authorRole, authorName, validatorSignatureHtml, validatorRole }) {
  // We don't parse HTML back — instead we pass structured data forward.
  // validatorSignatureHtml is used as a flag: if non-null, validator chose to sign.

  if (!authorRole) {
    // Automatic / system email
    return {
      signatureLeft:  [{ name: "L'Académie", role: 'Direction' }],
      signatureRight: { name: PRESIDENT_NAME, role: PRESIDENT_ROLE },
    };
  }

  if (authorRole === 'PRÉSIDENT') {
    return {
      signatureLeft:  [],
      signatureRight: { name: PRESIDENT_NAME, role: PRESIDENT_ROLE },
    };
  }

  if (authorRole === 'DIRECTRICE') {
    const left = [{ name: DIRECTRICE_NAME, role: DIRECTRICE_ROLE }];
    // Validator signed → it was approved by Président, add right column
    const right = validatorSignatureHtml ? { name: PRESIDENT_NAME, role: PRESIDENT_ROLE } : null;
    return { signatureLeft: left, signatureRight: right };
  }

  if (authorRole === 'PROFESSEUR') {
    // Validator is always Directrice for Professeur submissions
    const left = [{ name: authorName, role: `Professeur, L'Académie` }];
    if (validatorSignatureHtml) {
      left.push({ name: DIRECTRICE_NAME, role: DIRECTRICE_ROLE });
    }
    return { signatureLeft: left, signatureRight: null };
  }

  // Fallback
  return { signatureLeft: [], signatureRight: null };
}

// ── Email send helper (Resend) ─────────────────────────────────────────────────
const { sendEmail } = require('../services/email');

async function sendProxyEmail({ to, subject, body, html }) {
  try {
    await sendEmail(to, subject, body, html ?? null);
    return { ok: true, status: 200, body: 'sent' };
  } catch (err) {
    return { ok: false, status: 500, body: err.message };
  }
}

// ── Segment query builder ─────────────────────────────────────────────────────
// All filters AND-combined. Unsubscribed students always excluded.
// Actual DB schema:
//   student_saisons: id, student_id, saison_id, adhesion_payee, formule_id (FK→formulas), date_resiliation, cours_unite_count
//   students: formule (text/legacy), payment_method, sexe, email, archived_at, unsubscribed,
//             shoe_size, practice_levels (text[]), first_name, last_name
//   formulas: id, label
function buildSegmentQuery(filters = {}, countOnly = false) {
  const conditions = [];
  const params     = [];
  let   p          = 1;

  conditions.push(`s.archived_at IS NULL`);
  conditions.push(`s.unsubscribed = FALSE`);
  conditions.push(`s.email IS NOT NULL`);
  conditions.push(`s.email <> ''`);

  let needsSaison     = false;
  let needsDiscipline = false;
  let needsLocation   = false;

  // Text search on last_name
  if (filters.nom && filters.nom.trim()) {
    conditions.push(`s.last_name ILIKE $${p++}`);
    params.push(`%${filters.nom.trim()}%`);
  }
  // Text search on first_name
  if (filters.prenom && filters.prenom.trim()) {
    conditions.push(`s.first_name ILIKE $${p++}`);
    params.push(`%${filters.prenom.trim()}%`);
  }
  if (filters.formule_id) {
    needsSaison = true;
    conditions.push(`ss.formule_id = $${p++}`);
    params.push(parseInt(filters.formule_id, 10));
  }
  if (filters.payment_method) {
    conditions.push(`s.payment_method = $${p++}`);
    params.push(filters.payment_method);
  }
  if (filters.saison_id) {
    needsSaison = true;
    conditions.push(`ss.saison_id = $${p++}`);
    params.push(parseInt(filters.saison_id, 10));
  }
  if (typeof filters.adhesion === 'boolean' || filters.adhesion === 'true' || filters.adhesion === 'false') {
    needsSaison = true;
    const val = filters.adhesion === true || filters.adhesion === 'true';
    conditions.push(`ss.adhesion_payee = $${p++}`);
    params.push(val);
  }
  if (filters.sexe) {
    conditions.push(`s.sexe = $${p++}`);
    params.push(filters.sexe);
  }
  if (filters.shoe_size && filters.shoe_size.trim()) {
    conditions.push(`s.shoe_size ILIKE $${p++}`);
    params.push(filters.shoe_size.trim());
  }
  // practice_level: match any student whose practice_levels array contains the value
  if (filters.practice_level && filters.practice_level.trim()) {
    conditions.push(`$${p++} = ANY(s.practice_levels)`);
    params.push(filters.practice_level.trim());
  }
  if (filters.discipline_id) {
    needsDiscipline = true;
    conditions.push(`sd.discipline_id = $${p++}`);
    params.push(parseInt(filters.discipline_id, 10));
  }
  if (filters.location_id) {
    needsDiscipline = true;
    needsLocation   = true;
    conditions.push(`cl.location_id = $${p++}`);
    params.push(parseInt(filters.location_id, 10));
  }
  if (filters.age_min) {
    conditions.push(`DATE_PART('year', AGE(s.birth_date)) >= $${p++}`);
    params.push(parseInt(filters.age_min, 10));
  }
  if (filters.age_max) {
    conditions.push(`DATE_PART('year', AGE(s.birth_date)) <= $${p++}`);
    params.push(parseInt(filters.age_max, 10));
  }

  let joins = '';
  if (needsSaison)    joins += ` JOIN student_saisons ss ON ss.student_id = s.id`;
  if (needsDiscipline) joins += ` JOIN student_disciplines sd ON sd.student_id = s.id`;
  if (needsLocation)   joins += ` JOIN classes cl ON cl.discipline_id = sd.discipline_id`;

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  if (countOnly) {
    return { sql: `SELECT COUNT(DISTINCT s.id) AS count FROM students s${joins} ${whereClause}`, params };
  }
  return {
    sql: `SELECT DISTINCT s.id, s.first_name, s.last_name, s.email
          FROM students s${joins} ${whereClause}
          ORDER BY s.last_name, s.first_name`,
    params,
  };
}

// ── Build recipient list from explicit IDs ────────────────────────────────────
// Used by manual "À :" mode. Always re-validates against DB to enforce
// email presence and unsubscribe status.
async function fetchRecipientsById(pool, ids) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
  const result = await pool.query(
    `SELECT s.id, s.first_name, s.last_name, s.email
     FROM students s
     WHERE s.id IN (${placeholders})
       AND s.archived_at IS NULL
       AND s.unsubscribed = FALSE
       AND s.email IS NOT NULL
       AND s.email <> ''
     ORDER BY s.last_name, s.first_name`,
    ids.map(id => parseInt(id, 10))
  );
  return result.rows;
}

// ── Rate-limited batch sender ─────────────────────────────────────────────────
const BATCH_SIZE     = 10;
const BATCH_DELAY_MS = 1000;

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendBatch({ pool, campaignId, recipients, subject, bodyHtml, appUrl, authorRole, authorName, validatorSignatureHtml, validatorRole }) {
  let sent = 0, failed = 0;

  const { signatureLeft, signatureRight } = resolveSignatures({ authorRole, authorName, validatorSignatureHtml, validatorRole });

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const chunk = recipients.slice(i, i + BATCH_SIZE);

    await Promise.all(chunk.map(async (r) => {
      const pixelUrl  = `${appUrl}/api/messaging/pixel/${campaignId}/${r.recipientId}`;
      const unsubUrl  = `${appUrl}/api/messaging/unsubscribe/${r.studentId}`;

      const finalHtml = buildEmailTemplate({ bodyHtml, signatureLeft, signatureRight, pixelUrl, unsubUrl });

      const result = await sendProxyEmail({ to: r.email, subject, body: subject, html: finalHtml });
      const status  = result.ok ? 'sent' : 'failed';
      const sentAt  = result.ok ? new Date() : null;

      await pool.query(
        `UPDATE email_recipients SET status = $1, sent_at = $2 WHERE id = $3`,
        [status, sentAt, r.recipientId]
      );

      if (result.ok) sent++; else failed++;
    }));

    if (i + BATCH_SIZE < recipients.length) await delay(BATCH_DELAY_MS);
  }

  return { sent, failed };
}

// ── Notify validator by email ─────────────────────────────────────────────────
// Sends a plain notification email to the validator when a campaign awaits approval.
async function notifyValidator({ toEmail, toName, authorName, subject, campaignId, appUrl, action }) {
  const actionText = action === 'submitted'
    ? `${authorName} a soumis un email pour validation.`
    : `L'email a été ${action === 'approved' ? 'approuvé et envoyé' : 'rejeté'}.`;

  const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;font-size:14px;color:#333;max-width:560px;margin:32px auto;padding:0 16px">
  <div style="background:#0a0a0a;padding:20px;border-radius:8px 8px 0 0;text-align:center">
    <img src="${LOGO_URL}" alt="L'Académie" width="100" style="max-width:100px;height:auto">
  </div>
  <div style="background:#fff;padding:28px;border:1px solid #ece8e3;border-top:none;border-radius:0 0 8px 8px">
    <p style="margin:0 0 12px">Bonjour ${toName},</p>
    <p style="margin:0 0 20px">${actionText}</p>
    <p style="margin:0 0 8px"><strong>Objet :</strong> ${subject}</p>
    <div style="margin-top:24px">
      <a href="${appUrl}/messagerie" style="background:#c44d56;color:#fff;padding:10px 22px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
        Voir dans la Messagerie
      </a>
    </div>
  </div>
  <p style="font-size:11px;color:#9ca3af;text-align:center;margin-top:16px">THERPSIKHOROS SAS · lacademie.eu</p>
</body></html>`;

  return sendProxyEmail({ to: toEmail, subject: `[Messagerie] ${action === 'submitted' ? 'Validation demandée' : action === 'approved' ? 'Email approuvé' : 'Email rejeté'} — ${subject}`, body: `${actionText} Objet : ${subject}`, html });
}

// ── Router factory ────────────────────────────────────────────────────────────
module.exports = function createMessagingRouter({ pool, requireAuth }) {
  const router = express.Router();

  function getAppUrl(req) {
    return process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  }

  // Roles that can access the messaging composer
  const MESSAGING_ROLES = ['PRÉSIDENT', 'DIRECTRICE', 'PROFESSEUR'];

  // ── POST /api/messaging/preview ───────────────────────────────────────────
  // Supports two modes:
  //   { filters }        → segmentation mode (AND-combined filter object)
  //   { recipient_ids }  → manual mode (explicit student IDs, re-validated for email/unsubscribe)
  router.post('/preview', requireAuth(MESSAGING_ROLES), async (req, res) => {
    try {
      let rows;
      if (Array.isArray(req.body.recipient_ids)) {
        rows = await fetchRecipientsById(pool, req.body.recipient_ids);
      } else {
        const filters = req.body.filters || {};
        const { sql, params } = buildSegmentQuery(filters, false);
        const result = await pool.query(sql, params);
        rows = result.rows;
      }
      res.json({ count: rows.length, recipients: rows });
    } catch (err) {
      console.error('[messaging] POST /preview error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/messaging/submit ────────────────────────────────────────────
  // PROFESSEUR → notify DIRECTRICE (pending_validation)
  // DIRECTRICE → notify PRÉSIDENT  (pending_validation)
  // PRÉSIDENT  → direct send (created as 'sending', sent immediately)
  // Supports two recipient modes:
  //   { recipient_ids: [id…] }  → manual selection (validated server-side)
  //   { filters: {} }           → segmentation mode
  router.post('/submit', requireAuth(MESSAGING_ROLES), async (req, res) => {
    try {
      const { filters, recipient_ids, subject, body_html } = req.body;

      if (!subject || !subject.trim()) return res.status(400).json({ error: 'Objet requis' });
      if (!body_html || !body_html.trim()) return res.status(400).json({ error: 'Corps du message requis' });

      let recipients;
      let filtersUsed;
      if (Array.isArray(recipient_ids) && recipient_ids.length > 0) {
        recipients  = await fetchRecipientsById(pool, recipient_ids);
        filtersUsed = JSON.stringify({ mode: 'manual', count: recipient_ids.length });
      } else {
        const f = filters || {};
        const { sql, params } = buildSegmentQuery(f, false);
        const result = await pool.query(sql, params);
        recipients  = result.rows;
        filtersUsed = JSON.stringify(f);
      }

      if (recipients.length === 0) {
        return res.status(400).json({ error: 'Aucun destinataire correspondant aux filtres' });
      }

      const authorRole = req.user.role;
      const authorName = `${req.user.first_name} ${req.user.last_name}`;

      // PRÉSIDENT sends directly
      if (authorRole === 'PRÉSIDENT') {
        return handleDirectSend({ pool, req, res, recipients, subject, body_html, authorRole, authorName });
      }

      // Non-Président: find the validator
      let validatorRole;
      if (authorRole === 'DIRECTRICE') validatorRole = 'PRÉSIDENT';
      else validatorRole = 'DIRECTRICE'; // PROFESSEUR → DIRECTRICE

      const validatorRes = await pool.query(
        `SELECT id, email, first_name, last_name FROM app_users WHERE role = $1 AND active = true LIMIT 1`,
        [validatorRole]
      );

      if (validatorRes.rows.length === 0) {
        return res.status(400).json({ error: `Aucun ${validatorRole} actif trouvé pour validation` });
      }
      const validator = validatorRes.rows[0];

      // Resolve sender config
      const senderRow = await pool.query(`SELECT sender_email, sender_name FROM email_sender_config ORDER BY id LIMIT 1`);
      const senderEmail = senderRow.rows[0]?.sender_email || 'noreply@lacademie.polsia.app';
      const senderName  = senderRow.rows[0]?.sender_name  || "L'Académie";
      const sender      = `${senderName} <${senderEmail}>`;

      // Create campaign in pending_validation state
      const campaignRes = await pool.query(
        `INSERT INTO email_campaigns
           (subject, body_html, sender, filters_used, recipients_count, created_by, author_id, status, notified_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_validation', $8)
         RETURNING id`,
        [subject, body_html, sender, filtersUsed, recipients.length, req.user.id, req.user.id, validator.email]
      );
      const campaignId = campaignRes.rows[0].id;

      // Bulk-insert recipient rows (pending — not sent yet)
      if (recipients.length > 0) {
        const valuePlaceholders = recipients.map((_, idx) => {
          const base = idx * 3;
          return `($${base + 1}, $${base + 2}, $${base + 3})`;
        }).join(', ');
        const valueParams = recipients.flatMap(r => [campaignId, r.id, r.email]);
        await pool.query(
          `INSERT INTO email_recipients (campaign_id, student_id, email) VALUES ${valuePlaceholders}`,
          valueParams
        );
      }

      // Notify validator (fire-and-forget)
      const appUrl = getAppUrl(req);
      notifyValidator({
        toEmail:    validator.email,
        toName:     `${validator.first_name} ${validator.last_name}`,
        authorName,
        subject,
        campaignId,
        appUrl,
        action: 'submitted',
      }).catch(e => console.error('[messaging] notifyValidator error:', e));

      res.json({
        campaign_id:      campaignId,
        recipients_count: recipients.length,
        status:           'pending_validation',
        validator_email:  validator.email,
      });
    } catch (err) {
      console.error('[messaging] POST /submit error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/messaging/approve/:id ──────────────────────────────────────
  // Validator approves → optionally adds signature → triggers send
  // PRÉSIDENT approves DIRECTRICE campaigns, DIRECTRICE approves PROFESSEUR campaigns.
  router.post('/approve/:id', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const { id } = req.params;
      const { add_signature } = req.body; // boolean: validator wants to add their signature

      const campRes = await pool.query(
        `SELECT ec.*, u.role AS author_role, u.first_name AS author_first, u.last_name AS author_last
         FROM email_campaigns ec
         LEFT JOIN app_users u ON u.id = ec.author_id
         WHERE ec.id = $1`,
        [id]
      );
      if (campRes.rows.length === 0) return res.status(404).json({ error: 'Campagne introuvable' });

      const camp = campRes.rows[0];
      if (camp.status !== 'pending_validation') {
        return res.status(400).json({ error: 'Cette campagne n\'est pas en attente de validation' });
      }

      // Permission check: PRÉSIDENT validates DIRECTRICE, DIRECTRICE validates PROFESSEUR
      const validatorRole = req.user.role;
      const authorRole    = camp.author_role;
      if (validatorRole === 'DIRECTRICE' && authorRole !== 'PROFESSEUR') {
        return res.status(403).json({ error: 'La Directrice ne peut valider que les emails des Professeurs' });
      }

      // Flag validator signature intent (non-null = validator signed)
      const validatorSigFlag = add_signature ? 'yes' : null;
      const validatorName    = `${req.user.first_name} ${req.user.last_name}`;
      const authorName       = `${camp.author_first} ${camp.author_last}`;

      // Mark validated
      await pool.query(
        `UPDATE email_campaigns
         SET status = 'sending', validator_id = $1, validated_at = NOW(), validator_signature_html = $2
         WHERE id = $3`,
        [req.user.id, validatorSigFlag, id]
      );

      // Fetch recipient rows for send
      const recipientRows = await pool.query(
        `SELECT id AS "recipientId", student_id AS "studentId", email FROM email_recipients WHERE campaign_id = $1`,
        [id]
      );

      const appUrl = getAppUrl(req);

      res.json({ campaign_id: id, status: 'sending', recipients_count: recipientRows.rows.length });

      // Background send
      sendBatch({
        pool,
        campaignId: id,
        recipients: recipientRows.rows,
        subject:    camp.subject,
        bodyHtml:   camp.body_html,
        appUrl,
        authorRole,
        authorName,
        validatorSignatureHtml: validatorSigFlag,
        validatorRole,
      }).then(({ sent, failed }) => {
        pool.query(
          `UPDATE email_campaigns SET sent_at = NOW(), status = 'sent', recipients_count = $1 WHERE id = $2`,
          [sent, id]
        ).catch(e => console.error('[messaging] update sent_at error:', e));

        // Notify author that campaign was approved and sent
        if (camp.notified_email) {
          notifyValidator({
            toEmail:    camp.notified_email,
            toName:     authorName,
            authorName: validatorName,
            subject:    camp.subject,
            campaignId: id,
            appUrl,
            action: 'approved',
          }).catch(e => console.error('[messaging] notify author (approved) error:', e));
        }

        console.log(`[messaging] campaign ${id} approved+sent — sent:${sent} failed:${failed}`);
      }).catch(e => console.error('[messaging] batch send error (approve):', e));

    } catch (err) {
      console.error('[messaging] POST /approve/:id error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/messaging/reject/:id ───────────────────────────────────────
  // Validator rejects → campaign back to 'rejected' → email notif to author
  router.post('/reject/:id', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const { id } = req.params;
      const { reason = '' } = req.body;

      const campRes = await pool.query(
        `SELECT ec.*, u.role AS author_role, au.email AS author_email,
                u.first_name AS author_first, u.last_name AS author_last
         FROM email_campaigns ec
         LEFT JOIN app_users u ON u.id = ec.author_id
         LEFT JOIN app_users au ON au.id = ec.author_id
         WHERE ec.id = $1`,
        [id]
      );
      if (campRes.rows.length === 0) return res.status(404).json({ error: 'Campagne introuvable' });

      const camp = campRes.rows[0];
      if (camp.status !== 'pending_validation') {
        return res.status(400).json({ error: 'Cette campagne n\'est pas en attente de validation' });
      }

      const validatorRole = req.user.role;
      const authorRole    = camp.author_role;
      if (validatorRole === 'DIRECTRICE' && authorRole !== 'PROFESSEUR') {
        return res.status(403).json({ error: 'La Directrice ne peut rejeter que les emails des Professeurs' });
      }

      await pool.query(
        `UPDATE email_campaigns
         SET status = 'rejected', validator_id = $1, validated_at = NOW(), rejection_reason = $2
         WHERE id = $3`,
        [req.user.id, reason || null, id]
      );

      const appUrl    = getAppUrl(req);
      const authorName = `${camp.author_first} ${camp.author_last}`;
      const validatorName = `${req.user.first_name} ${req.user.last_name}`;

      // Notify author
      if (camp.author_email) {
        notifyValidator({
          toEmail:    camp.author_email,
          toName:     authorName,
          authorName: validatorName,
          subject:    camp.subject,
          campaignId: id,
          appUrl,
          action: 'rejected',
        }).catch(e => console.error('[messaging] notify author (rejected) error:', e));
      }

      res.json({ campaign_id: id, status: 'rejected' });
    } catch (err) {
      console.error('[messaging] POST /reject/:id error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── POST /api/messaging/send ──────────────────────────────────────────────
  // Legacy direct-send endpoint (PRÉSIDENT only — same behaviour as before).
  // Kept for backwards compatibility; /submit is the new preferred path.
  router.post('/send', requireAuth(['PRÉSIDENT']), async (req, res) => {
    try {
      const { filters = {}, subject, body_html } = req.body;
      if (!subject || !subject.trim()) return res.status(400).json({ error: 'Objet requis' });
      if (!body_html || !body_html.trim()) return res.status(400).json({ error: 'Corps du message requis' });

      const { sql, params } = buildSegmentQuery(filters, false);
      const result = await pool.query(sql, params);
      const recipients = result.rows;
      if (recipients.length === 0) return res.status(400).json({ error: 'Aucun destinataire' });

      const authorRole = req.user.role;
      const authorName = `${req.user.first_name} ${req.user.last_name}`;
      return handleDirectSend({ pool, req, res, recipients, subject, body_html, authorRole, authorName });
    } catch (err) {
      console.error('[messaging] POST /send error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/messaging/campaigns ─────────────────────────────────────────
  router.get('/campaigns', requireAuth(MESSAGING_ROLES), async (req, res) => {
    try {
      const page    = Math.max(1, parseInt(req.query.page    || '1',  10));
      const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page || '20', 10)));
      const offset  = (page - 1) * perPage;

      // PROFESSEUR sees only their own campaigns; others see all
      const authorFilter = req.user.role === 'PROFESSEUR'
        ? `WHERE ec.author_id = ${req.user.id}`
        : '';

      const [countRes, rowsRes] = await Promise.all([
        pool.query(`SELECT COUNT(*) AS total FROM email_campaigns ec ${authorFilter}`),
        pool.query(
          `SELECT
             ec.id, ec.subject, ec.sender, ec.filters_used, ec.recipients_count,
             ec.sent_at, ec.created_at, ec.status,
             u.first_name || ' ' || u.last_name AS created_by_name,
             COUNT(er.id) FILTER (WHERE er.status = 'sent')   AS sent_count,
             COUNT(er.id) FILTER (WHERE er.status = 'failed') AS failed_count,
             COUNT(er.id) FILTER (WHERE er.status = 'opened') AS opened_count
           FROM email_campaigns ec
           LEFT JOIN app_users u ON u.id = ec.created_by
           LEFT JOIN email_recipients er ON er.campaign_id = ec.id
           ${authorFilter}
           GROUP BY ec.id, u.first_name, u.last_name
           ORDER BY ec.created_at DESC
           LIMIT $1 OFFSET $2`,
          [perPage, offset]
        ),
      ]);

      const total = parseInt(countRes.rows[0].total, 10);
      res.json({ total, page, per_page: perPage, total_pages: Math.ceil(total / perPage), campaigns: rowsRes.rows });
    } catch (err) {
      console.error('[messaging] GET /campaigns error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/messaging/pending ────────────────────────────────────────────
  // Returns campaigns awaiting THIS user's validation role.
  router.get('/pending', requireAuth(['PRÉSIDENT', 'DIRECTRICE']), async (req, res) => {
    try {
      const role = req.user.role;
      // PRÉSIDENT validates DIRECTRICE submissions; DIRECTRICE validates PROFESSEUR
      const authorRole = role === 'PRÉSIDENT' ? 'DIRECTRICE' : 'PROFESSEUR';

      const rows = await pool.query(
        `SELECT ec.id, ec.subject, ec.created_at, ec.recipients_count,
                u.first_name || ' ' || u.last_name AS author_name, u.role AS author_role
         FROM email_campaigns ec
         LEFT JOIN app_users u ON u.id = ec.author_id
         WHERE ec.status = 'pending_validation' AND u.role = $1
         ORDER BY ec.created_at ASC`,
        [authorRole]
      );

      res.json({ pending: rows.rows });
    } catch (err) {
      console.error('[messaging] GET /pending error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/messaging/campaigns/:id ─────────────────────────────────────
  router.get('/campaigns/:id', requireAuth(MESSAGING_ROLES), async (req, res) => {
    try {
      const { id } = req.params;

      const [campRes, recipRes] = await Promise.all([
        pool.query(
          `SELECT ec.*,
                  u.first_name || ' ' || u.last_name AS created_by_name,
                  v.first_name || ' ' || v.last_name AS validator_name
           FROM email_campaigns ec
           LEFT JOIN app_users u ON u.id = ec.created_by
           LEFT JOIN app_users v ON v.id = ec.validator_id
           WHERE ec.id = $1`,
          [id]
        ),
        pool.query(
          `SELECT er.id, er.email, er.status, er.sent_at, er.opened_at,
                  s.first_name, s.last_name
           FROM email_recipients er
           LEFT JOIN students s ON s.id = er.student_id
           WHERE er.campaign_id = $1
           ORDER BY er.id`,
          [id]
        ),
      ]);

      if (campRes.rows.length === 0) return res.status(404).json({ error: 'Campagne introuvable' });

      const campaign   = campRes.rows[0];
      const recipients = recipRes.rows;

      const stats = {
        total:   recipients.length,
        sent:    recipients.filter(r => r.status === 'sent' || r.status === 'opened').length,
        failed:  recipients.filter(r => r.status === 'failed').length,
        opened:  recipients.filter(r => r.status === 'opened').length,
        pending: recipients.filter(r => r.status === 'pending').length,
      };
      stats.open_rate = stats.sent > 0 ? Math.round((stats.opened / stats.sent) * 100) : 0;

      res.json({ campaign, stats, recipients });
    } catch (err) {
      console.error('[messaging] GET /campaigns/:id error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/messaging/pixel/:campaignId/:recipientId ────────────────────
  const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  router.get('/pixel/:campaignId/:recipientId', async (req, res) => {
    try {
      const { campaignId, recipientId } = req.params;
      await pool.query(
        `UPDATE email_recipients SET status = 'opened', opened_at = NOW()
         WHERE id = $1 AND campaign_id = $2 AND status = 'sent'`,
        [recipientId, campaignId]
      );
    } catch (e) { /* never break email rendering */ }
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.end(TRANSPARENT_GIF);
  });

  // ── GET /api/messaging/unsubscribe/:studentId ─────────────────────────────
  router.get('/unsubscribe/:studentId', async (req, res) => {
    try {
      const { studentId } = req.params;
      await pool.query(`UPDATE students SET unsubscribed = TRUE WHERE id = $1`, [studentId]);
      res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Désinscription — L'Académie</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 16px;text-align:center;color:#374151}h1{color:#c44d56}p{color:#6b7280}</style>
</head><body>
<h1>Désinscription confirmée</h1>
<p>Vous ne recevrez plus d'emails de L'Académie.</p>
<p>Pour vous réinscrire, contactez l'école directement.</p>
</body></html>`);
    } catch (err) {
      console.error('[messaging] unsubscribe error:', err);
      res.status(500).send('Erreur — veuillez réessayer.');
    }
  });

  // ── GET /api/messaging/autocomplete?q=… ──────────────────────────────────
  // Returns up to 20 active students matching the query across first_name, last_name,
  // and combined "first last" / "last first" patterns. Used by manual "À :" field.
  // Only students with an email address are returned.
  router.get('/autocomplete', requireAuth(MESSAGING_ROLES), async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q || q.length < 2) return res.json({ students: [] });

      const pattern = `%${q}%`;
      const result  = await pool.query(
        `SELECT id, first_name, last_name, email
         FROM students
         WHERE archived_at IS NULL
           AND unsubscribed = FALSE
           AND email IS NOT NULL
           AND email <> ''
           AND (
             first_name ILIKE $1
             OR last_name  ILIKE $1
             OR (first_name || ' ' || last_name) ILIKE $1
             OR (last_name  || ' ' || first_name) ILIKE $1
           )
         ORDER BY last_name, first_name
         LIMIT 20`,
        [pattern]
      );
      res.json({ students: result.rows });
    } catch (err) {
      console.error('[messaging] GET /autocomplete error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ── GET /api/messaging/filters/options ───────────────────────────────────
  // Actual schema:
  //   formulas: id, label (student_saisons.formule_id → formulas.id)
  //   disciplines: id, name
  //   locations: id, city
  //   saisons: id, nom, date_debut, date_fin, active
  //   students: payment_method (text)
  router.get('/filters/options', requireAuth(MESSAGING_ROLES), async (req, res) => {
    try {
      const [formules, disciplines, locations, saisons, modes, practiceLevels, shoeSizes] = await Promise.all([
        pool.query(`SELECT id, label FROM formulas WHERE active = true ORDER BY position, label`),
        pool.query(`SELECT id, name FROM disciplines ORDER BY name`),
        pool.query(`SELECT id, city FROM locations ORDER BY city`),
        pool.query(`SELECT id, nom AS label FROM saisons ORDER BY date_debut DESC`),
        pool.query(`SELECT DISTINCT payment_method FROM students WHERE payment_method IS NOT NULL AND payment_method <> '' ORDER BY payment_method`),
        // Unnest the practice_levels array to get all distinct values used across students
        pool.query(`SELECT DISTINCT unnest(practice_levels) AS val FROM students WHERE practice_levels IS NOT NULL AND archived_at IS NULL ORDER BY val`),
        pool.query(`SELECT DISTINCT shoe_size FROM students WHERE shoe_size IS NOT NULL AND shoe_size <> '' AND archived_at IS NULL ORDER BY shoe_size`),
      ]);

      res.json({
        formules:        formules.rows,
        disciplines:     disciplines.rows,
        locations:       locations.rows,
        saisons:         saisons.rows,
        modes_paiement:  modes.rows.map(r => r.payment_method),
        sexes:           ['M', 'F', 'Autre'],
        practice_levels: practiceLevels.rows.map(r => r.val),
        shoe_sizes:      shoeSizes.rows.map(r => r.shoe_size),
      });
    } catch (err) {
      console.error('[messaging] GET /filters/options error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};

// ── Direct send helper (PRÉSIDENT bypass) ────────────────────────────────────
async function handleDirectSend({ pool, req, res, recipients, subject, body_html, authorRole, authorName }) {
  const senderRow = await pool.query(`SELECT sender_email, sender_name FROM email_sender_config ORDER BY id LIMIT 1`);
  const senderEmail = senderRow.rows[0]?.sender_email || 'noreply@lacademie.polsia.app';
  const senderName  = senderRow.rows[0]?.sender_name  || "L'Académie";
  const sender      = `${senderName} <${senderEmail}>`;

  const campaignRes = await pool.query(
    `INSERT INTO email_campaigns
       (subject, body_html, sender, filters_used, recipients_count, created_by, author_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'sending')
     RETURNING id`,
    [subject, body_html, sender, '{}', recipients.length, req.user.id, req.user.id]
  );
  const campaignId = campaignRes.rows[0].id;

  if (recipients.length > 0) {
    const valuePlaceholders = recipients.map((_, idx) => {
      const base = idx * 3;
      return `($${base + 1}, $${base + 2}, $${base + 3})`;
    }).join(', ');
    const valueParams = recipients.flatMap(r => [campaignId, r.id, r.email]);
    await pool.query(`INSERT INTO email_recipients (campaign_id, student_id, email) VALUES ${valuePlaceholders}`, valueParams);
  }

  const recipientRows = await pool.query(
    `SELECT id AS "recipientId", student_id AS "studentId", email FROM email_recipients WHERE campaign_id = $1`,
    [campaignId]
  );

  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;

  res.json({ campaign_id: campaignId, recipients_count: recipients.length, status: 'sending' });

  sendBatch({
    pool,
    campaignId,
    recipients: recipientRows.rows,
    subject,
    bodyHtml: body_html,
    appUrl,
    authorRole,
    authorName,
    validatorSignatureHtml: null,
    validatorRole: null,
  }).then(({ sent, failed }) => {
    pool.query(
      `UPDATE email_campaigns SET sent_at = NOW(), status = 'sent', recipients_count = $1 WHERE id = $2`,
      [sent, campaignId]
    ).catch(e => console.error('[messaging] update sent_at (direct send) error:', e));
    console.log(`[messaging] campaign ${campaignId} (direct) — sent:${sent} failed:${failed}`);
  }).catch(e => console.error('[messaging] batch error (direct send):', e));
}
