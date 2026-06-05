# AcadémieOS — CLAUDE.md

## What this app does
CRM for a dance school (L'Académie). Manages student registration, class scheduling, weekly attendance, payments, and PDF exports. Also serves a standalone PWA tablet app for taking roll-call during classes.

## Stack
Node.js + Express · PostgreSQL (Neon) · Vanilla JS frontend · Render deploy · PDFKit · xlsx

## Directory map
- `server.js` — Single entry file: all routes, middleware, auth, business logic (legacy god file — do not add to it)
- `routes/` — Express routers for feature modules (`archives.js`, `attendance.js`, `student-audit.js`, `students-export.js`, `famille.js`, `stats.js`, `messaging.js`, `fiche-prix.js`, `comparatif.js`, `saisons.js`, `appel-pdf.js`, `payments.js`, `encaissement.js`, `moderation.js`, `reseau.js`, `student-auth.js`)
- `db/` — Database query modules (`formulas.js`, `saisons.js`, `classes.js`, `payment-entries.js`, `attendance.js`, `moderation.js`, `student-accounts.js`). Each exports named functions that accept the pool.
- `public/` — Static HTML pages served directly (each page is self-contained)
- `migrations/` — node-pg-migrate JS migration files (DDL only here)
- `migrate.js` — Migration runner executed at startup
- `debug/` — Dev/debug scripts (not deployed)
- `session-env/` — Session environment snapshots
- `todos/` — Internal task notes

## Database
- `students` — Student profiles, contact info, levels, formule, numero_adherent, droit_image, certificat_medical, sexe, unsubscribed (email opt-out), date_adhesion (nullable, prorata base for billing)
- `disciplines` — 11 dance disciplines (immutable seeded list)
- `locations` — 2 studios: Arcachon, Gujan-Mestras
- `classes` — Weekly recurring classes (discipline × location × day_of_week × time)
- `student_disciplines` — Many-to-many enrollment (student ↔ discipline)
- `attendance` — Per-session presence records (class, student, date, status: present/absent/excused)
- `formula_attendance` — Per-formula presence records (student, formula, date, status, noted_by). UNIQUE student×formula×date.
- `formulas` — Subscription formulas with pricing (11 seeded)
- `saisons` — Academic seasons (statut: active/cloturee); clôturée seasons are read-only
- `student_saisons` — Per-season student enrollment (formule, adhesion_payee, adhesion_incluse, résiliation, amount_paid_cents)
- `app_users` — CRM users with roles (PRÉSIDENT, DIRECTRICE, PROFESSEUR, CLIENT, INVITÉ)
- `sessions` — Auth sessions (Bearer token, 7-day expiry)
- `audit_logs` — Action audit trail
- `student_change_log` — Per-field change history on student fiches (old/new values, author, financial_context JSONB for formula recalcs)
- `famille_groupes` / `famille_beneficiaires` — Family group billing links
- `class_passagers` — Drop-in guest counts per class session
- `tablet_pins` — PIN codes for tablet /appel access (label, bcrypt hash, revocable)
- `tablet_sessions` — 30-day sessions issued after PIN auth (no link to CRM accounts)
- `email_campaigns` — One row per email blast; status: draft/pending_validation/sending/sent/rejected; author_id, validator_id, validator_signature_html flag
- `email_recipients` — Per-recipient tracking (campaign_id, student_id, email, status: pending/sent/failed/opened, opened_at)
- `email_sender_config` — Configurable sender address (default: noreply@lacademie.polsia.app)
- `saison_formulas` — Per-saison copy of pricing formulas (duplicated on season clone)
- `payment_entries` — Dated individual payment records (student_id, saison_id, amount_cents, payment_date, payment_method, notes, created_by). Source of truth for `amount_paid_cents`.
- `student_accounts` — Student-linked social accounts (student_id FK, email, password_hash, is_active)
- `posts` — CRM staff posts (PRESIDENT/DIRECTRICE): title, content, image_url, author_role/name, timestamps
- `conversations` / `conversation_participants` / `messages` — Private DM system (student ↔ student)
- `course_groups` / `course_group_members` / `group_messages` — Per-class group chat
- `moderation_actions` — Audit trail for staff moderation (delete_message/block_student/unblock_student)
- `student_blocks` — Student blocking records (blocked_by_role, blocked_at, unblocked_at)
- `message_reports` — Student reports for moderation (reporter, message_type/message_id, reason, resolved)
- `post_reactions` — Student emoji reactions on CRM posts (post_id, student_account_id, emoji)
- `conversation_reads` — Per-student read position in DM conversations (for unread badges)

## External integrations
- **Polsia email proxy** — `POLSIA_API_URL` + `POLSIA_API_KEY` for transactional emails and bulk campaign sends

## Recent changes
- 2026-06-03: Groupes réseau social complet — unread badges, preview dernier message, timestamp, panneau membres (slide-over). Routes: `/api/reseau/groups` (unread via group_reads), `/api/reseau/groups/:id/members`. Migration: `1851000000000_group_unread_reads.js` (table group_reads).
- 2026-06-02: Student social network (`/reseau`) + modération — `public/reseau.html` (student login + feed + DMs + groups + report button), `routes/reseau.js` (student API), `routes/student-auth.js` (temp password login), `db/student-accounts.js` (student auth helpers). Migration: `1780500000000_student_social.js` (post_reactions, conversation_reads, student_temp_pwd token type).
- 2026-06-01: Outils modération CRM — Section "Réseau social > Modération" dans dashboard (PRÉSIDENT + DIRECTRICE). Vue messages (DMs + groupes), suppression soft-delete, blocage/déblocage élèves, signalements, journal actions. Zero notification sortante. Fichiers: `db/moderation.js`, `routes/moderation.js`, `public/dashboard.html`.
- 2026-05-28: Supprimer réseau social du CRM — Routes `/api/reseau/*`, `/api/student-accounts/*`, `/reseau` supprimées.
- 2026-05-28: Fix auth_tokens constraints — CHECK constraint élargie pour accepter `reseau_crm` + `student_session`. FK `user_id → app_users` supprimée (student sessions stockent `student_accounts.id`). Fichier: `migrations/1753700000000_fix_auth_tokens_type_check.js`.

