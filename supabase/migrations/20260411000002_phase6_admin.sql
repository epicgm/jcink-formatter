-- ============================================================
-- Migration: 003 — Phase 6 admin and board library
-- ============================================================

-- ── users: soft-deactivation ─────────────────────────────────

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS active bool NOT NULL DEFAULT true;

-- ── board_library: rejection notes ───────────────────────────

ALTER TABLE public.board_library
  ADD COLUMN IF NOT EXISTS rejection_note text;

-- ── board_library: allow authenticated users to suggest ───────
-- Original policy only allowed admins to INSERT.
-- Replace it so any logged-in user can submit a pending suggestion.

DROP POLICY IF EXISTS "board_library_insert" ON public.board_library;

CREATE POLICY "board_library_insert" ON public.board_library
  FOR INSERT WITH CHECK (
    -- Admins can insert with any status
    public.is_admin()
    OR
    -- Regular users can only insert suggestions (status must be 'pending')
    (auth.uid() IS NOT NULL AND status = 'pending' AND added_by = auth.uid())
  );

-- ── board_library: only admins can update/approve/reject ──────
-- (existing policy unchanged — re-stated here for clarity)
-- board_library_update: USING (is_admin()) WITH CHECK (is_admin())

-- ── users: admins can update active field ────────────────────
-- The existing users_update policy already allows admins to update any user row.
-- No change needed.
