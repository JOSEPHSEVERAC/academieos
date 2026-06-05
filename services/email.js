// services/email.js
// Owns: all transactional email sending via Resend.
// Does NOT own: email campaign batch sends (routes/messaging.js), auth tokens, student data.
//
// Transport: Resend (direct API — no Polsia proxy).

const nodemailer = require('nodemailer');
const { Resend } = require('resend');

const FROM_EMAIL    = process.env.FROM_EMAIL    || 'contact@lacademie.art';
const FROM_NAME      = "L'Académie";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const IS_PRODUCTION  = process.env.NODE_ENV === 'production';

// Lazy-initialised nodemailer transport (requires RESEND_API_KEY at runtime).
// We create the transport once and reuse it across all emails.
let _transport = null;
function getTransport() {
  if (_transport) return _transport;
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — emails will be logged to console only');
    _transport = null;
    return null;
  }
  const resend = new Resend(RESEND_API_KEY);
  _transport = nodemailer.createTransport({
    JSONTransport: true, // We send via Resend API directly, not via SMTP
  });
  _transport._resend = resend; // attach resend client for direct API calls
  return _transport;
}

/**
 * Send a transactional email via Resend.
 * Falls back to console.log in non-production if RESEND_API_KEY is not configured.
 *
 * @param {string} to      - recipient email address
 * @param {string} subject  - email subject
 * @param {string} body     - plain-text body
 * @param {string} [html]   - optional HTML body
 */
async function sendEmail(to, subject, body, html = null) {
  const transport = getTransport();

  if (!transport) {
    console.log(`[email:noop] would send to ${to} — subject: ${subject}`);
    console.log(`[email:noop] body: ${body.substring(0, 100)}...`);
    return;
  }

  console.log(`[email] Sending to ${to} — subject: ${subject}`);

  try {
    const resend = transport._resend;
    const result = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [to],
      subject,
      text: body,
      ...(html ? { html } : {}),
    });

    if (result.error) {
      throw new Error(`Resend error: ${JSON.stringify(result.error)}`);
    }

    console.log(`[email] Sent — Resend message ID: ${result.data?.id}`);
    return result.data;
  } catch (err) {
    console.error(`[email] Failed to send to ${to}: ${err.message}`);
    throw err;
  }
}

module.exports = { sendEmail };