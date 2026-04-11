-- ============================================================
-- Migration: 002 — Phase 4 library enhancements
-- ============================================================

-- ── New columns on user_library ──────────────────────────────

-- Track "auto-add to new templates within a character" preference
ALTER TABLE public.user_library
  ADD COLUMN IF NOT EXISTS auto_add_new_templates bool NOT NULL DEFAULT false;

-- Track board_library source for "Add" (locked) copies.
-- NULL  = personal block (or a Fork from board, which uses forked_from instead)
-- UUID  = an Add-copy that tracks a board block and can receive updates
ALTER TABLE public.user_library
  ADD COLUMN IF NOT EXISTS board_source_id uuid
    REFERENCES public.board_library(id) ON DELETE SET NULL;

-- ── Fix forked_from FK to reference board_library ────────────
-- The original schema pointed forked_from → user_library (for future
-- peer-to-peer forking).  Phase 4 uses it to record which board block
-- a user forked, so we retarget it to board_library.
ALTER TABLE public.user_library
  DROP CONSTRAINT IF EXISTS user_library_forked_from_fkey;

ALTER TABLE public.user_library
  ADD CONSTRAINT user_library_forked_from_fkey
    FOREIGN KEY (forked_from)
    REFERENCES public.board_library(id) ON DELETE SET NULL;

-- ── board_library: expose used_by_count updater ─────────────
-- Increment used_by_count when a user adds or forks a board block.
CREATE OR REPLACE FUNCTION public.board_library_increment_used_by(block_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.board_library
     SET used_by_count = used_by_count + 1
   WHERE id = block_id;
$$;
