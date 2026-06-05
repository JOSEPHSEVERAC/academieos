// routes/fiche-prix.js
// Owns: read-only pricing grid API + PDF export for the official "fiche des prix".
// Does NOT own: formula CRUD, student enrollment, billing.

const express = require('express');
const PDFDocument = require('pdfkit');
const https = require('https');
const { getActiveFormulas, getActiveSaisonLabel } = require('../db/formulas');

// Logo URL — same corrected PNG used by messaging module
const LOGO_URL = 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_98213/images/c14f688c-4f74-46d3-a097-a49cda1d65ec.png';

module.exports = function createFichePrixRouter({ pool }) {
  const router = express.Router();

  // ──────────────────────────────────────────────────────────────
  // GET /api/fiche-prix — JSON pricing grid
  // ──────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const [formulas, saison] = await Promise.all([
        getActiveFormulas(pool),
        getActiveSaisonLabel(pool),
      ]);

      // Group formulas for structured display
      const inscription = formulas.find(f => f.label === 'Inscription');

      // 1 cours/semaine tiers
      const eveil = formulas.find(f => f.label === 'Éveil et Initiation');
      const preparatoire = formulas.find(f => f.label === 'Préparatoire');
      const collectif = formulas.find(f => f.label === 'Collectif standard');

      // 2 cours/semaine tiers
      const eveil2 = formulas.find(f => f.label === 'Éveil et Initiation — 2 cours/sem');
      const preparatoire2 = formulas.find(f => f.label === 'Préparatoire — 2 cours/sem');
      const collectif2 = formulas.find(f => f.label === 'Collectif standard — 2 cours/sem');

      // Unlimited
      const illimiteSolo = formulas.find(f => f.label === 'Illimité solo');
      const illimiteFamille = formulas.find(f => f.label === 'Illimité famille');
      const illimiteBenef = formulas.find(f => f.label === 'Illimité famille (bénéficiaire)');

      // Drop-in
      const coursUnite = formulas.find(f => f.label === 'Cours à l\u2019unité');

      res.json({
        saison: saison || 'Saison en cours',
        inscription,
        cours_collectifs_1x: { eveil, preparatoire, collectif },
        cours_collectifs_2x: { eveil: eveil2, preparatoire: preparatoire2, collectif: collectif2 },
        illimites: { solo: illimiteSolo, famille: illimiteFamille, beneficiaire: illimiteBenef },
        cours_unite: coursUnite,
        all_formulas: formulas,
      });
    } catch (err) {
      console.error('Error fetching fiche-prix:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // GET /api/fiche-prix/pdf — A4 PDF export (faithful to official sheet)
  // ──────────────────────────────────────────────────────────────
  router.get('/pdf', async (req, res) => {
    try {
      const [formulas, saison] = await Promise.all([
        getActiveFormulas(pool),
        getActiveSaisonLabel(pool),
      ]);

      const saisonLabel = saison || 'Saison en cours';

      // Helper: find formula by label
      const f = (label) => formulas.find(x => x.label === label);

      // Fetch logo image as buffer
      const logoBuffer = await fetchImageBuffer(LOGO_URL);

      const doc = new PDFDocument({ size: 'A4', margin: 0 });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="fiche-tarifs-${saisonLabel.replace('/', '-')}.pdf"`);
      doc.pipe(res);

      const W = 595.28;
      const H = 841.89;
      const MARGIN = 50;
      const CW = W - MARGIN * 2;
      const INK = '#0a0a0a';
      const WHITE = '#ffffff';
      let y = 50;

      // ── Banner: TARIFS SAISON 2025/2026 ──
      doc.rect(MARGIN, y, CW, 36).fill(INK);
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(16)
        .text(`TARIFS SAISON ${saisonLabel}`, MARGIN, y + 10, { width: CW, align: 'center' });
      y += 50;

      // ── Inscription ──
      const insc = f('Inscription');
      const inscPrix = insc ? `${insc.prix_cents / 100}€` : '25€';
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
        .text(`Inscription :   ${inscPrix} par personne`, MARGIN, y, { width: CW, align: 'center' });
      y += 30;

      // ── COURS COLLECTIFS* ──
      doc.rect(MARGIN, y, CW, 28).fill(INK);
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(13)
        .text('COURS COLLECTIFS*', MARGIN, y + 7, { width: CW, align: 'center' });
      y += 36;

      // ── Sub-banner: Tarif mensuel 1 cours/semaine ──
      doc.rect(MARGIN, y, CW, 24).fill('#333333');
      doc.fillColor(WHITE).font('Helvetica-BoldOblique').fontSize(10)
        .text('Tarif mensuel/personne à partir de 1 cours par semaine :', MARGIN + 10, y + 7, { width: CW - 20 });
      y += 34;

      // Price lines — 1x/week
      const eveil = f('Éveil et Initiation');
      const prep = f('Préparatoire');
      const coll = f('Collectif standard');

      y = drawPriceLine(doc, '-  Eveil et Initiation :', eveil ? `${eveil.prix_cents / 100}€` : '25€', MARGIN, y, CW);
      y = drawPriceLine(doc, '-  Préparatoire :', prep ? `${prep.prix_cents / 100}€` : '27€', MARGIN, y, CW);
      y += 4;

      // Long discipline list line
      const disciplineText = '-  Elémentaire / Moyen / Moyen-supérieur / Supérieur avancé / Préparation Battle / Ragga / Break / Hip-Hop / Pilates / stretching / yoga stretching / full body / cardio CAF / barre à terre / jazz latino / fit boxing / circuit cardio training / mobilité et renforcement musculaire :';
      const collPrix = coll ? `${coll.prix_cents / 100}€` : '30€';

      doc.fillColor(INK).font('Helvetica').fontSize(10);
      const textH = doc.heightOfString(disciplineText, { width: CW - 60 });
      doc.text(disciplineText, MARGIN, y, { width: CW - 60 });
      doc.font('Helvetica-Bold').fontSize(11)
        .text(collPrix, MARGIN + CW - 55, y + textH - 14, { width: 50, align: 'right' });
      y += textH + 16;

      // ── Sub-banner: Tarif mensuel 2 cours/semaine ──
      const eveil2 = f('Éveil et Initiation — 2 cours/sem');
      const prep2 = f('Préparatoire — 2 cours/sem');
      const coll2 = f('Collectif standard — 2 cours/sem');

      if (eveil2 || prep2 || coll2) {
        doc.rect(MARGIN, y, CW, 24).fill('#333333');
        doc.fillColor(WHITE).font('Helvetica-BoldOblique').fontSize(10)
          .text('Tarif mensuel/personne à partir de 2 cours par semaine :', MARGIN + 10, y + 7, { width: CW - 20 });
        y += 34;

        if (eveil2) y = drawPriceLine(doc, '-  Eveil et Initiation (2 cours/sem) :', `${eveil2.prix_cents / 100}€`, MARGIN, y, CW);
        if (prep2) y = drawPriceLine(doc, '-  Préparatoire (2 cours/sem) :', `${prep2.prix_cents / 100}€`, MARGIN, y, CW);
        if (coll2) y = drawPriceLine(doc, '-  Collectif standard (2 cours/sem) :', `${coll2.prix_cents / 100}€`, MARGIN, y, CW);
        y += 6;
      }

      // ── Tarif mensuel cours illimités ──
      doc.rect(MARGIN, y, CW, 28).fill(INK);
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(12)
        .text('Tarif mensuel cours illimités :', MARGIN, y + 7, { width: CW, align: 'center' });
      y += 36;

      doc.fillColor(INK).font('Helvetica-Oblique').fontSize(9)
        .text('A partir de 3 cours par semaine', MARGIN, y, { width: CW, align: 'center' });
      y += 20;

      const solo = f('Illimité solo');
      const famille = f('Illimité famille');
      y = drawPriceLine(doc, '-  Forfait personne seule :', solo ? `${solo.prix_cents / 100}€` : '70€', MARGIN, y, CW);
      y = drawPriceLine(doc, '-  Forfait famille (3 personnes max.) :', famille ? `${famille.prix_cents / 100}€` : '90€', MARGIN, y, CW);
      y += 6;

      // ── Cours à l'unité ──
      doc.rect(MARGIN, y, CW, 28).fill(INK);
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(12)
        .text('Cours à l\u2019unité :', MARGIN, y + 7, { width: CW, align: 'center' });
      y += 36;

      const unite = f('Cours à l\u2019unité');
      const unitePrix = unite ? `${unite.prix_cents / 100}€` : '15€';
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
        .text(unitePrix, MARGIN, y, { width: CW, align: 'center' });
      y += 22;

      doc.fillColor(INK).font('Helvetica-Oblique').fontSize(8)
        .text('*pour les cours particuliers, s\u2019adresser directement au professeur souhaité', MARGIN, y, { width: CW });
      y += 30;

      // ── Footer: company info + logo ──
      const footerY = H - 120;

      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
        .text('THERPSIKHOROS SAS', MARGIN, footerY, { width: CW, align: 'center' });
      doc.font('Helvetica').fontSize(8)
        .text('833 749 344 R.C.S. Bordeaux', MARGIN, footerY + 13, { width: CW, align: 'center' })
        .text('24 rue Paul Pouget - 33470 Gujan-Mestras', MARGIN, footerY + 24, { width: CW, align: 'center' });

      // Logo centered
      if (logoBuffer) {
        try {
          doc.image(logoBuffer, W / 2 - 30, footerY + 40, { width: 60 });
        } catch (_) { /* logo fetch failed — skip gracefully */ }
      }

      doc.fillColor(INK).font('Helvetica').fontSize(8)
        .text('Tel : 05 56 54 45 51', MARGIN, footerY + 55, { width: CW / 2 - 30, align: 'right' })
        .text('Email : lacadmie@gmail.com', MARGIN + CW / 2 + 30, footerY + 55, { width: CW / 2 - 30, align: 'left' });
      doc.text('www.lacademie.eu', MARGIN, footerY + 68, { width: CW, align: 'center' });

      doc.end();
    } catch (err) {
      console.error('Error generating fiche-prix PDF:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF' });
    }
  });

  return router;
};

// ── Helpers ──

function drawPriceLine(doc, label, price, margin, y, cw) {
  doc.fillColor('#0a0a0a').font('Helvetica').fontSize(11)
    .text(label, margin, y, { width: cw - 55, continued: false });
  doc.font('Helvetica-Bold').fontSize(11)
    .text(price, margin + cw - 50, y, { width: 45, align: 'right' });
  return y + 20;
}

/**
 * Fetch an image from a URL and return it as a Buffer for PDFKit.
 * Returns null on failure (non-blocking).
 */
function fetchImageBuffer(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}
