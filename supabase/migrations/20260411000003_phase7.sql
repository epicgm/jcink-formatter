-- ============================================================
-- Migration: 004 — Phase 7 backup system
-- ============================================================

-- ── backup_log: add detail column for filename or error ───────────────────────

ALTER TABLE public.backup_log
  ADD COLUMN IF NOT EXISTS detail text;

-- ── Webhook setup note ───────────────────────────────────────────────────────
-- Configure two Database Webhooks in the Supabase Dashboard:
--   Dashboard → Database → Webhooks → Create new webhook
--
--   Webhook 1:
--     Name:  backup-on-character-change
--     Table: characters
--     Events: INSERT, UPDATE, DELETE
--     Method: POST
--     URL: https://<project-ref>.supabase.co/functions/v1/backup-to-github
--
--   Webhook 2:
--     Name:  backup-on-template-change
--     Table: templates
--     Events: INSERT, UPDATE, DELETE
--     Method: POST
--     URL: https://<project-ref>.supabase.co/functions/v1/backup-to-github
--
-- Secrets to set (supabase secrets set KEY=value):
--   GITHUB_TOKEN — GitHub personal access token with repo write scope
--   GITHUB_REPO  — "owner/repo" of the private backup repository
