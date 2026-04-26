-- ============================================================
-- Migration: add display_name to user_library and board_library
-- ============================================================

-- User blocks: friendly label shown as card title (falls back to trigger if null)
ALTER TABLE public.user_library
  ADD COLUMN IF NOT EXISTS display_name text;

-- Board blocks: same
ALTER TABLE public.board_library
  ADD COLUMN IF NOT EXISTS display_name text;
