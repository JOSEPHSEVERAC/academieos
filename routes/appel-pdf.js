// routes/appel-pdf.js
// Owns: public PDF exports accessible from the tablet /appel homepage.
//   - GET /planning — weekly class schedule (landscape A4, single page)
//   - GET /inscription — blank student registration form (portrait A4, 3 pages)
// Does NOT own: attendance recording, PIN auth, CRM-side PDF exports (fiche-prix).
// Auth: tablet PIN session OR CRM session (validated by server.js blanket middleware).
// These paths are added to TABLET_ALLOWED_PATHS so tablet sessions can reach them.

const express = require('express');
const PDFDocument = require('pdfkit');
const https = require('https');

const LOGO_URL = 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev/company_98213/images/c14f688c-4f74-46d3-a097-a49cda1d65ec.png';

const DAYS_FR = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6];

const INK = '#0a0a0a';
const WHITE = '#ffffff';
const ROSE = '#c44d56';
const MUTED = '#555555';

// Footer text shared across both PDFs
const FOOTER_TEXT = "L'Académie · THERPSIKHOROS SAS · 833 749 344 R.C.S. Bordeaux · lacadmie@gmail.com";

module.exports = function createAppelPdfRouter({ pool }) {
  const router = express.Router();

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/appel-pdf/planning — weekly schedule, SINGLE landscape A4 page
  // Exact copy of the CRM dashboard schedule grid: time×day matrix with
  // proportional row heights, location-colored cards, and identical styling.
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/planning', async (req, res) => {
    try {
      // Prevent browser caching — ensures fresh PDFs after every deploy
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      const [classesResult, saisonResult] = await Promise.all([
        pool.query(`
          SELECT c.id, c.day_of_week, c.start_time, c.end_time,
                 c.teacher_name, c.secondary_label, c.practice_levels,
                 d.name AS discipline_name, d.color AS discipline_color,
                 l.name AS location_name, l.city AS location_city
          FROM classes c
          JOIN disciplines d ON c.discipline_id = d.id
          JOIN locations  l ON c.location_id  = l.id
          WHERE c.active = true
          ORDER BY c.day_of_week, c.start_time
        `),
        pool.query(`SELECT nom FROM saisons WHERE active = true LIMIT 1`),
      ]);

      const classes = classesResult.rows;
      const saisonLabel = saisonResult.rows[0]?.nom || 'Saison en cours';

      // Location label — all sites combined
      const locRes = await pool.query('SELECT DISTINCT city FROM locations ORDER BY city');
      const locationLabel = locRes.rows.length > 0
        ? locRes.rows.map(r => r.city).join(' & ')
        : 'Tous les sites';

      // Location color scheme — mirrors CRM dashboard exactly
      const LOC_COLORS = {
        'Arcachon': { bg: '#e0edff', text: '#1e40af', accent: '#3b82f6' },
        'Gujan-Mestras': { bg: '#fce7f3', text: '#9d174d', accent: '#ec4899' }
      };

      const SLATE = '#444444';

      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, autoFirstPage: false });
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 0 });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="planning-${saisonLabel.replace('/', '-')}.pdf"`);
      doc.pipe(res);

      const PW = 841.89;
      const PH = 595.28;
      const MARGIN = 14;
      const CW = PW - MARGIN * 2;

      // === HEADER — identical to CRM schedule PDF ===
      const HEADER_H = 52;
      doc.rect(0, 0, PW, HEADER_H).fill(INK);
      doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(18)
        .text("L'ACAD\u00c9MIE", MARGIN + 8, 10, { continued: false });
      doc.fillColor(WHITE).font('Helvetica').fontSize(8)
        .text('Joseph-S\u00e9verac', MARGIN + 8, 30);
      doc.fillColor('rgba(255,255,255,0.85)').font('Helvetica-Bold').fontSize(10)
        .text('Emploi du Temps', PW - MARGIN - 260, 11, { width: 250, align: 'right' });
      doc.fillColor('rgba(255,255,255,0.6)').font('Helvetica').fontSize(8)
        .text(`${saisonLabel} \u2014 ${locationLabel}`, PW - MARGIN - 260, 25, { width: 250, align: 'right' });
      const now = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
      doc.fillColor('rgba(255,255,255,0.4)').font('Helvetica').fontSize(7)
        .text(`Export\u00e9 le ${now}`, PW - MARGIN - 260, 37, { width: 250, align: 'right' });

      // === Location legend bar ===
      const legendY = HEADER_H + 3;
      let legendX = MARGIN + 8;
      doc.rect(0, HEADER_H, PW, 16).fill('#f0eee9');
      const citiesInExport = [...new Set(classes.map(c => c.location_city).filter(Boolean))].sort();
      citiesInExport.forEach(city => {
        const colors = LOC_COLORS[city] || { bg: '#f0f0f0', text: '#555', accent: ROSE };
        doc.rect(legendX, legendY + 2, 8, 8).fillColor(colors.accent).fill();
        doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(7)
          .text(city, legendX + 11, legendY + 3);
        legendX += doc.widthOfString(city, { font: 'Helvetica-Bold', fontSize: 7 }) + 26;
      });

      const LEGEND_H = 16;
      const GRID_Y = HEADER_H + LEGEND_H;
      const FOOTER_H = 16;
      const GRID_H = PH - GRID_Y - MARGIN - FOOTER_H;

      const TIME_W = 42;
      const DAYS_W = CW - TIME_W;
      const DAY_W = DAYS_W / 6;

      // Group classes by day+hour — exactly like CRM renderGrid()
      const classMap = {};
      classes.forEach(c => {
        const h = parseInt((c.start_time || '').split(':')[0]);
        const key = c.day_of_week + '-' + h;
        if (!classMap[key]) classMap[key] = [];
        classMap[key].push(c);
      });

      const DAY_NUMS = [1, 2, 3, 4, 5, 6];
      const DAYS_LABELS = ['LUNDI', 'MARDI', 'MERCREDI', 'JEUDI', 'VENDREDI', 'SAMEDI'];

      // Compute hour range from actual data
      const allHours = classes.map(c => parseInt((c.start_time || '08').split(':')[0]));
      const minH = allHours.length ? Math.min(...allHours) : 8;
      const maxH = allHours.length ? Math.max(...allHours) : 20;
      const hourCount = maxH - minH + 1;

      if (!classes.length) {
        doc.fillColor(INK).font('Helvetica').fontSize(12)
          .text('Aucun cours programmé.', MARGIN, GRID_Y + 40, { width: CW, align: 'center' });
        doc.end();
        return;
      }

      const DAY_HDR_H = 20;
      const DATA_H = GRID_H - DAY_HDR_H;

      // Proportional row heights based on content density — CRM pattern
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
      const actualTotal = rowHeights.reduce((a, b) => a + b, 0);
      const scale = DATA_H / actualTotal;
      const finalRowHeights = rowHeights.map(h => h * scale);

      // Grid background
      doc.rect(MARGIN, GRID_Y, CW, GRID_H).fillColor('#faf8f5').fill();

      // Day header row — dark background with white text
      doc.rect(MARGIN, GRID_Y, TIME_W, DAY_HDR_H).fillColor('#2d2d2d').fill();
      DAYS_LABELS.forEach((day, i) => {
        const x = MARGIN + TIME_W + i * DAY_W;
        doc.rect(x, GRID_Y, DAY_W, DAY_HDR_H).fillColor('#2d2d2d').fill();
        doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(7)
          .text(day, x, GRID_Y + (DAY_HDR_H - 7) / 2, { width: DAY_W, align: 'center' });
      });

      // Hour rows — time×day grid with cards
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

              // Location-based card styling — mirrors CRM exactly
              const locColors = c.location_city
                ? (LOC_COLORS[c.location_city] || { bg: '#f0f0f0', text: '#555', accent: color })
                : null;
              const cardBg = locColors ? locColors.bg : (color + '15');
              const accentColor = locColors ? locColors.accent : color;

              // Card background + left accent bar
              doc.rect(x + 2, cy, DAY_W - 4, ch).fillColor(cardBg).fill();
              doc.rect(x + 2, cy, 2.5, ch).fillColor(accentColor).fill();

              // Discipline name (with secondary label if present)
              const titleFontSize = ch >= 28 ? 8.5 : 7.5;
              const title = c.secondary_label
                ? `${c.discipline_name} \u2014 ${c.secondary_label}`
                : c.discipline_name;
              doc.fillColor(INK).font('Helvetica-Bold').fontSize(titleFontSize)
                .text(title, x + 6.5, cy + 2, { width: DAY_W - 10, lineBreak: false, ellipsis: true });

              // Time + teacher line
              if (ch >= 18) {
                const timeStr = `${fmtTime(c.start_time)}\u2013${fmtTime(c.end_time)}`;
                const infoLine = c.teacher_name ? `${timeStr} \u00b7 ${c.teacher_name}` : timeStr;
                doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(7)
                  .text(infoLine, x + 6.5, cy + 2 + titleFontSize + 1.5, { width: DAY_W - 10, lineBreak: false, ellipsis: true });
              }

              // Levels + location line
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

        // Time column right border + outer right border
        doc.moveTo(MARGIN + TIME_W, rowY).lineTo(MARGIN + TIME_W, rowY + rh).strokeColor('#ddd8d2').lineWidth(0.3).stroke();
        doc.moveTo(MARGIN + CW, rowY).lineTo(MARGIN + CW, rowY + rh).strokeColor('#ddd8d2').lineWidth(0.3).stroke();
        // Horizontal row border
        doc.moveTo(MARGIN, rowY).lineTo(MARGIN + CW, rowY).strokeColor('#ddd8d2').lineWidth(0.3).stroke();

        rowY += rh;
      }

      // Bottom + outer borders
      doc.moveTo(MARGIN, rowY).lineTo(MARGIN + CW, rowY).strokeColor('#ddd8d2').lineWidth(0.3).stroke();
      doc.rect(MARGIN, GRID_Y, CW, GRID_H).strokeColor('#c8c4be').lineWidth(0.5).stroke();

      // === Footer ===
      const totalClasses = classes.length;
      doc.fillColor(MUTED).font('Helvetica').fontSize(6.5)
        .text(`${totalClasses} cours \u2022 ${locationLabel} \u2022 ${saisonLabel} \u2022 G\u00e9n\u00e9r\u00e9 le ${now}`, MARGIN, PH - MARGIN - 9, { width: CW, align: 'center' });

      doc.end();
    } catch (err) {
      console.error('[appel-pdf] planning error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Erreur génération PDF planning' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/appel-pdf/inscription — blank student registration form
  // 3 pages A4 portrait — exact reproduction of the CRM inscription form.
  //   Page 1: Student info, guardian, disciplines, formulas with prices
  //   Page 2: RGPD (Therpsikhoros SAS), droit à l'image, consentements
  //   Page 3: Signature + conditions contractuelles
  // ─────────────────────────────────────────────────────────────────────────
  router.get('/inscription', async (req, res) => {
    try {
      // Prevent browser caching — ensures fresh PDFs after every deploy
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');

      const [saisonResult, disciplinesResult, logoBuffer] = await Promise.all([
        pool.query(`SELECT nom FROM saisons WHERE active = true LIMIT 1`),
        pool.query(`SELECT name FROM disciplines ORDER BY id`),
        fetchImageBuffer(LOGO_URL),
      ]);

      const saisonLabel = saisonResult.rows[0]?.nom || 'Saison en cours';
      const disciplines = disciplinesResult.rows;

      const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="fiche-inscription-${saisonLabel.replace('/', '-')}.pdf"`);
      doc.pipe(res);

      const W = 595.28;
      const H = 841.89;
      const M = 40; // margin
      const CW = W - M * 2;

      // ════════════════════════════════════════════════════════════════════════
      // PAGE 1 — Informations élève, responsable légal, disciplines, formules
      // ════════════════════════════════════════════════════════════════════════
      doc.addPage({ size: 'A4', margin: 0 });
      let y = M;

      // ── Header ──
      if (logoBuffer) {
        try { doc.image(logoBuffer, M, y, { height: 48 }); } catch (_) {}
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(17)
        .text("FICHE D'INSCRIPTION", M + 80, y + 4, { width: CW - 80, align: 'right' });
      doc.fillColor(ROSE).font('Helvetica-Bold').fontSize(11)
        .text(`Saison ${saisonLabel}`, M + 80, y + 24, { width: CW - 80, align: 'right' });
      y += 52;

      // School info line
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
        .text("L'Académie · THERPSIKHOROS SAS · 24 rue Paul Pouget, 33470 Gujan-Mestras · Tél : 05 56 54 45 51 · www.lacademie.eu", M, y, { width: CW, align: 'center' });
      y += 12;

      doc.rect(M, y, CW, 0.8).fill(INK);
      y += 6;

      // ── Section: Informations de l'élève ──
      y = drawSectionTitle(doc, "INFORMATIONS DE L'ÉLÈVE", M, y, CW);

      y = drawField(doc, 'Nom', M, y, CW * 0.5 - 6);
      y -= FIELD_H;
      drawField(doc, 'Prénom', M + CW * 0.5 + 6, y, CW * 0.5 - 6);
      y += FIELD_H;

      y = drawField(doc, 'Date de naissance', M, y, CW * 0.35 - 4);
      y -= FIELD_H;
      // Sexe with drawn checkboxes
      const sexeX = M + CW * 0.35 + 4;
      doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text('Sexe', sexeX, y);
      drawCheckbox(doc, sexeX + 28, y + 1);
      doc.fillColor(INK).font('Helvetica').fontSize(7.5).text('M', sexeX + 39, y, { lineBreak: false });
      drawCheckbox(doc, sexeX + 55, y + 1);
      doc.fillColor(INK).font('Helvetica').fontSize(7.5).text('F', sexeX + 66, y, { lineBreak: false });
      doc.rect(sexeX, y + 12, CW * 0.2, 0.5).fill('#999999');

      drawField(doc, 'N° adhérent (si renouvellement)', M + CW * 0.55 + 4, y, CW * 0.45 - 4);
      y += FIELD_H;

      y = drawField(doc, 'Adresse', M, y, CW * 0.7 - 4);
      y -= FIELD_H;
      drawField(doc, 'Code postal', M + CW * 0.7 + 4, y, CW * 0.3 - 4);
      y += FIELD_H;

      y = drawField(doc, 'Ville', M, y, CW * 0.5 - 4);
      y -= FIELD_H;
      drawField(doc, 'Téléphone', M + CW * 0.5 + 4, y, CW * 0.5 - 4);
      y += FIELD_H;

      y = drawField(doc, 'Email', M, y, CW);

      // ── Section: Responsable légal ──
      y = drawSectionTitle(doc, 'RESPONSABLE LÉGAL (pour les mineurs)', M, y, CW);

      y = drawField(doc, 'Nom et prénom', M, y, CW * 0.6 - 4);
      y -= FIELD_H;
      drawField(doc, 'Lien de parenté', M + CW * 0.6 + 4, y, CW * 0.4 - 4);
      y += FIELD_H;

      y = drawField(doc, 'Téléphone', M, y, CW * 0.5 - 4);
      y -= FIELD_H;
      drawField(doc, 'Email', M + CW * 0.5 + 4, y, CW * 0.5 - 4);
      y += FIELD_H;

      y = drawField(doc, 'Adresse (si différente de l\'élève)', M, y, CW);

      // ── Section: Disciplines choisies ──
      y = drawSectionTitle(doc, 'DISCIPLINE(S) CHOISIE(S)', M, y, CW);

      const DISC_COLS = 3;
      const discColW = CW / DISC_COLS;
      let discRow = 0;
      disciplines.forEach((d, i) => {
        const col = i % DISC_COLS;
        if (col === 0 && i > 0) discRow++;
        const dx = M + col * discColW;
        const dy = y + discRow * 15;
        drawCheckbox(doc, dx, dy + 1);
        doc.fillColor(INK).font('Helvetica').fontSize(8.5)
          .text(d.name, dx + 13, dy, { width: discColW - 17, lineBreak: false });
      });
      const discRows = Math.ceil(disciplines.length / DISC_COLS);
      y += discRows * 15 + 6;

      // ── Section: Formule tarifaire ──
      y = drawSectionTitle(doc, 'FORMULE TARIFAIRE', M, y, CW);

      // Hardcoded formulas from the spec — source of truth (barème 2025/2026, adhésion 25€ séparée)
      const formulaLines = [
        { label: 'Éveil & Initiation', detail: '250€/an + 25€ adhésion (25€/mois ×10)' },
        { label: 'Éveil & Initiation — 2 cours/sem', detail: '500€/an + 25€ adhésion (2×25€/mois ×10)' },
        { label: 'Préparatoire', detail: '270€/an + 25€ adhésion (27€/mois ×10)' },
        { label: 'Préparatoire — 2 cours/sem', detail: '540€/an + 25€ adhésion (2×27€/mois ×10)' },
        { label: 'Collectif Standard', detail: '300€/an + 25€ adhésion (30€/mois ×10)' },
        { label: 'Collectif Standard — 2 cours/sem', detail: '600€/an + 25€ adhésion (2×30€/mois ×10)' },
        { label: 'Illimité Solo', detail: '25€ adhésion + tarif mensuel×10' },
        { label: 'Illimité Famille (titulaire)', detail: '900€/an + 25€ adhésion (90€/mois ×10)' },
        { label: 'Illimité Famille (bénéficiaire)', detail: '25€ adhésion uniquement (formule 0€)' },
        { label: 'Cours à l\'Unité', detail: '25€ adhésion + 15€/cours' },
      ];

      formulaLines.forEach((f) => {
        drawCheckbox(doc, M, y + 1);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(8)
          .text(f.label, M + 13, y, { continued: true, lineBreak: false });
        doc.font('Helvetica').fontSize(8)
          .text(`  —  ${f.detail}`, { lineBreak: false });
        y += 14;
      });
      y += 4;

      // ── Mode de paiement ──
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8.5)
        .text('Mode de paiement :', M, y);
      y += 13;

      const payModes = ['Prélèvement', 'Chèque(s)', 'Espèces', 'Virement', 'CB'];
      let px = M;
      payModes.forEach((mode) => {
        drawCheckbox(doc, px, y + 1);
        doc.fillColor(INK).font('Helvetica').fontSize(8)
          .text(mode, px + 13, y, { lineBreak: false });
        px += 90;
      });
      y += 14;

      doc.fillColor(INK).font('Helvetica').fontSize(8)
        .text('Nombre de chèques :  _______   (maximum 10 chèques/an)', M, y);
      y += 14;

      // ── Footer page 1 ──
      drawPageFooter(doc, M, W, H, CW);

      // ════════════════════════════════════════════════════════════════════════
      // PAGE 2 — RGPD, droit à l'image, consentements
      // ════════════════════════════════════════════════════════════════════════
      doc.addPage({ size: 'A4', margin: 0 });
      y = M;

      // Mini header
      if (logoBuffer) {
        try { doc.image(logoBuffer, M, y, { height: 32 }); } catch (_) {}
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
        .text("FICHE D'INSCRIPTION — CONDITIONS", M + 60, y + 8, { width: CW - 60, align: 'right' });
      y += 42;
      doc.rect(M, y, CW, 0.8).fill(INK);
      y += 8;

      // ── RGPD ──
      y = drawSectionTitle(doc, 'PROTECTION DES DONNÉES PERSONNELLES (RGPD)', M, y, CW);

      const rgpdText = [
        'Conformément au Règlement Général sur la Protection des Données (RGPD) et à la loi « Informatique et Libertés » du 6 janvier 1978 modifiée, THERPSIKHOROS SAS, en qualité de responsable de traitement, collecte et traite vos données personnelles aux fins suivantes :',
        '',
        '  •  Gestion des inscriptions et du suivi pédagogique',
        '  •  Communication relative aux activités de l\'école (horaires, événements, spectacles)',
        '  •  Facturation et suivi comptable',
        '  •  Obligation légale (assurance, fédération)',
        '',
        'Vos données sont conservées pendant la durée de votre inscription et au maximum 3 ans après la fin de celle-ci, sauf obligation légale contraire.',
        '',
        'Vous disposez d\'un droit d\'accès, de rectification, d\'effacement, de limitation du traitement, de portabilité et d\'opposition. Pour exercer ces droits, adressez votre demande à : lacadmie@gmail.com ou par courrier à THERPSIKHOROS SAS — 24 rue Paul Pouget, 33470 Gujan-Mestras.',
      ];

      for (const line of rgpdText) {
        if (line === '') { y += 4; continue; }
        const lh = doc.font('Helvetica').fontSize(8).heightOfString(line, { width: CW });
        doc.fillColor(INK).font('Helvetica').fontSize(8)
          .text(line, M, y, { width: CW });
        y += lh + 2;
      }
      y += 6;

      // ── Droit à l'image ──
      y = drawSectionTitle(doc, "DROIT À L'IMAGE", M, y, CW);

      drawCheckbox(doc, M, y + 1);
      const imgText = "J'autorise THERPSIKHOROS SAS (L'Académie) à photographier et/ou filmer l'élève dans le cadre des activités de l'école (cours, répétitions, spectacles, événements) et à utiliser ces images à des fins pédagogiques, de communication et de promotion de l'école (site internet, réseaux sociaux, affiches, plaquettes). Cette autorisation est valable pour la durée de l'inscription.";
      const imgH = doc.font('Helvetica').fontSize(8).heightOfString(imgText, { width: CW - 15 });
      doc.fillColor(INK).font('Helvetica').fontSize(8)
        .text(imgText, M + 15, y, { width: CW - 15 });
      y += imgH + 6;

      drawCheckbox(doc, M, y + 1);
      doc.fillColor(INK).font('Helvetica').fontSize(8)
        .text("Je refuse l'utilisation de l'image de l'élève.", M + 15, y);
      y += 16;

      // ── Certificat médical ──
      y = drawSectionTitle(doc, 'CERTIFICAT MÉDICAL', M, y, CW);

      drawCheckbox(doc, M, y + 1);
      doc.fillColor(INK).font('Helvetica').fontSize(8)
        .text("Je certifie que l'élève est apte à la pratique de la danse et des activités physiques proposées.", M + 15, y, { width: CW - 15 });
      y += 14;

      doc.fillColor(INK).font('Helvetica').fontSize(8)
        .text("Un certificat médical de non contre-indication à la pratique de la danse, datant de moins de 3 mois, est obligatoire pour toute inscription.", M, y, { width: CW });
      y += 22;

      // ── Règlement intérieur ──
      y = drawSectionTitle(doc, 'RÈGLEMENT INTÉRIEUR', M, y, CW);

      drawCheckbox(doc, M, y + 1);
      doc.fillColor(INK).font('Helvetica').fontSize(8)
        .text("Je reconnais avoir pris connaissance du règlement intérieur de l'école et m'engage à le respecter.", M + 15, y, { width: CW - 15 });
      y += 18;

      // ── Engagement et résiliation ──
      y = drawSectionTitle(doc, 'ENGAGEMENT ET RÉSILIATION', M, y, CW);

      const resiliationClauses = [
        "L'inscription est valable pour la saison complète (septembre à juin).",
        "En cas de résiliation en cours de saison, un préavis d'un mois est obligatoire (avant le 1er du mois). Les sommes déjà versées ne sont pas remboursables, sauf cas de force majeure (maladie justifiée par certificat médical, déménagement).",
        "L'école se réserve le droit de modifier les horaires, les salles ou les enseignants en cours de saison pour des raisons organisationnelles.",
        "L'école se réserve le droit de refuser ou d'annuler une inscription en cas de non-respect du règlement intérieur.",
      ];

      for (const clause of resiliationClauses) {
        const ch = doc.font('Helvetica').fontSize(8).heightOfString('  •  ' + clause, { width: CW });
        doc.fillColor(INK).font('Helvetica').fontSize(8)
          .text('  •  ' + clause, M, y, { width: CW });
        y += ch + 4;
      }

      // ── Footer page 2 ──
      drawPageFooter(doc, M, W, H, CW);

      // ════════════════════════════════════════════════════════════════════════
      // PAGE 3 — Signature + conditions contractuelles
      // ════════════════════════════════════════════════════════════════════════
      doc.addPage({ size: 'A4', margin: 0 });
      y = M;

      // Mini header
      if (logoBuffer) {
        try { doc.image(logoBuffer, M, y, { height: 32 }); } catch (_) {}
      }
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(13)
        .text("FICHE D'INSCRIPTION — SIGNATURE", M + 60, y + 8, { width: CW - 60, align: 'right' });
      y += 42;
      doc.rect(M, y, CW, 0.8).fill(INK);
      y += 8;

      // ── Récapitulatif engagement ──
      y = drawSectionTitle(doc, 'RÉCAPITULATIF DE L\'ENGAGEMENT', M, y, CW);

      doc.fillColor(INK).font('Helvetica').fontSize(9)
        .text('En signant cette fiche, je reconnais :', M, y, { width: CW });
      y += 14;

      const engagements = [
        'Avoir pris connaissance et accepter les conditions tarifaires de la saison en cours.',
        'Avoir pris connaissance du règlement intérieur et m\'engager à le respecter.',
        'Autoriser (ou refuser) l\'utilisation de l\'image de l\'élève selon la case cochée en page 2.',
        'Certifier l\'exactitude des informations fournies dans cette fiche.',
        'M\'engager à fournir un certificat médical de non contre-indication à la pratique de la danse.',
        'Accepter les conditions de résiliation énoncées en page 2.',
      ];

      for (const eng of engagements) {
        drawCheckbox(doc, M + 4, y + 1);
        const eh = doc.font('Helvetica').fontSize(8.5).heightOfString(eng, { width: CW - 22 });
        doc.fillColor(INK).font('Helvetica').fontSize(8.5)
          .text(eng, M + 18, y, { width: CW - 22 });
        y += eh + 5;
      }

      y += 10;

      // ── Numéro adhérent ──
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
        .text('N° adhérent (réservé à l\'école) :', M, y);
      doc.rect(M + 180, y - 2, 150, 16).strokeColor('#999999').lineWidth(0.5).stroke();
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7)
        .text('Format : YYYYSS-NNNN', M + 185, y + 1);
      y += 28;

      // ── Date et lieu ──
      doc.fillColor(INK).font('Helvetica').fontSize(9)
        .text('Fait à : ________________________________     le : ______ / ______ / ____________', M, y, { width: CW });
      y += 28;

      // ── Signature responsable légal / élève majeur ──
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
        .text('Signature du responsable légal (ou de l\'élève majeur) :', M, y);
      y += 14;
      doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7)
        .text('(précédée de la mention « Lu et approuvé »)', M, y);
      y += 12;
      doc.rect(M, y, CW * 0.48, 70).strokeColor('#aaaaaa').lineWidth(0.5).stroke();

      // ── Cachet école ──
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
        .text('Cachet et signature de l\'école :', M + CW * 0.52, y - 26);
      doc.rect(M + CW * 0.52, y, CW * 0.48, 70).strokeColor('#aaaaaa').lineWidth(0.5).stroke();

      y += 82;

      // ── Conditions contractuelles ──
      y = drawSectionTitle(doc, 'CONDITIONS CONTRACTUELLES', M, y, CW);

      const conditions = [
        "La présente fiche d'inscription constitue un contrat entre l'élève (ou son représentant légal) et THERPSIKHOROS SAS, exploitant l'école de danse L'Académie.",
        "Tarifs : les tarifs indiqués sont valables pour la saison en cours. L'adhésion annuelle de 25€ est obligatoire, non remboursable et s'ajoute à la formule choisie. Les mensualités sont dues de septembre à juin (10 mois).",
        "Paiement : le règlement peut être effectué par prélèvement automatique, chèque (maximum 10), espèces, virement bancaire ou carte bancaire. En cas de paiement par chèques, l'ensemble des chèques est remis à l'inscription et encaissé mensuellement.",
        "Absences : les cours manqués ne sont ni remboursés ni rattrapables, sauf cas de force majeure justifié. Les cours annulés par l'école seront reprogrammés ou remboursés au prorata.",
        "Assurance : l'élève doit être couvert par une assurance responsabilité civile. L'école décline toute responsabilité en cas d'accident survenu en dehors des heures de cours ou des locaux.",
        "Vacances scolaires : l'école suit le calendrier des vacances scolaires de la zone A. Aucun cours n'est dispensé pendant les vacances scolaires et les jours fériés.",
        "Tribunal compétent : en cas de litige, le tribunal compétent sera celui de Bordeaux.",
      ];

      for (const cond of conditions) {
        const ch = doc.font('Helvetica').fontSize(7.5).heightOfString(cond, { width: CW });
        doc.fillColor(INK).font('Helvetica').fontSize(7.5)
          .text(cond, M, y, { width: CW });
        y += ch + 4;
      }

      // ── Footer page 3 ──
      drawPageFooter(doc, M, W, H, CW);

      doc.end();
    } catch (err) {
      console.error('[appel-pdf] inscription error:', err);
      if (!res.headersSent) res.status(500).json({ error: "Erreur génération PDF fiche d'inscription" });
    }
  });

  return router;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const FIELD_H = 26;

/**
 * Draw a section title with dark background banner.
 * Returns updated y position after the banner.
 */
function drawSectionTitle(doc, title, x, y, width) {
  doc.rect(x, y, width, 17).fill(INK);
  doc.fillColor(WHITE).font('Helvetica-Bold').fontSize(8.5)
    .text(title, x + 6, y + 4, { width: width - 12, lineBreak: false });
  return y + 22;
}

/**
 * Draw a labeled underline field. Returns y + FIELD_H.
 */
function drawField(doc, label, x, y, width) {
  doc.fillColor(MUTED).font('Helvetica').fontSize(7)
    .text(label, x, y, { width, lineBreak: false });
  doc.rect(x, y + 11, width, 0.5).fill('#999999');
  return y + FIELD_H;
}

/**
 * Draw a checkbox square (empty rectangle) at (x, y). 9×9pt.
 */
function drawCheckbox(doc, x, y) {
  doc.rect(x, y, 9, 9).strokeColor(INK).lineWidth(0.7).stroke();
}

/**
 * Draw page footer at bottom of current page.
 */
function drawPageFooter(doc, margin, pageW, pageH, contentW) {
  doc.fillColor(MUTED).font('Helvetica').fontSize(6.5)
    .text(FOOTER_TEXT, margin, pageH - margin - 8, { width: contentW, align: 'center', lineBreak: false });
}

/**
 * Format HH:MM:SS → HH:MM
 */
function fmtTime(t) {
  return t ? t.slice(0, 5) : '';
}

/**
 * Fetch an image URL and return it as a Buffer.
 * Returns null on any failure (non-blocking).
 */
function fetchImageBuffer(url) {
  return new Promise((resolve) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}
