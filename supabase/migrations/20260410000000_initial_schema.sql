-- ============================================================
-- Migration: 001 — Initial schema
-- Tables: users, characters, templates, user_library,
--         board_library, backup_log
-- ============================================================

-- ── Extensions ──────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Tables ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.users (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username    text        UNIQUE NOT NULL,
  role        text        NOT NULL DEFAULT 'user',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.characters (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.templates (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id     uuid        NOT NULL REFERENCES public.characters(id) ON DELETE CASCADE,
  name             text        NOT NULL,
  shell_html       text,
  rules_json       jsonb,
  active_block_ids uuid[],
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_library (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  trigger             text        NOT NULL,
  replacement_html    text,
  is_global           bool        NOT NULL DEFAULT false,
  auto_add_new_chars  bool        NOT NULL DEFAULT false,
  forked_from         uuid        REFERENCES public.user_library(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.board_library (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger          text NOT NULL,
  replacement_html text,
  added_by         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'pending',
  used_by_count    int  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.backup_log (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  triggered_by text,
  status       text
);

-- ── Enable RLS on every table ────────────────────────────────

ALTER TABLE public.users         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.characters    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.templates     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_library  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.board_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backup_log    ENABLE ROW LEVEL SECURITY;

-- ── Admin helper ─────────────────────────────────────────────
-- SECURITY DEFINER means the function runs as its owner (postgres)
-- so it can read public.users without hitting RLS recursion.

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- ── users policies ───────────────────────────────────────────

CREATE POLICY "users_select" ON public.users
  FOR SELECT USING (id = auth.uid() OR public.is_admin());

CREATE POLICY "users_insert" ON public.users
  FOR INSERT WITH CHECK (id = auth.uid());

CREATE POLICY "users_update" ON public.users
  FOR UPDATE
  USING    (id = auth.uid() OR public.is_admin())
  WITH CHECK (id = auth.uid() OR public.is_admin());

CREATE POLICY "users_delete" ON public.users
  FOR DELETE USING (id = auth.uid() OR public.is_admin());

-- ── characters policies ──────────────────────────────────────

CREATE POLICY "characters_select" ON public.characters
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "characters_insert" ON public.characters
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "characters_update" ON public.characters
  FOR UPDATE
  USING    (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "characters_delete" ON public.characters
  FOR DELETE USING (user_id = auth.uid() OR public.is_admin());

-- ── templates policies ───────────────────────────────────────
-- Ownership is via characters.user_id (one hop away).

CREATE POLICY "templates_select" ON public.templates
  FOR SELECT USING (
    public.is_admin() OR
    EXISTS (SELECT 1 FROM public.characters c
            WHERE c.id = character_id AND c.user_id = auth.uid())
  );

CREATE POLICY "templates_insert" ON public.templates
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.characters c
            WHERE c.id = character_id AND c.user_id = auth.uid())
  );

CREATE POLICY "templates_update" ON public.templates
  FOR UPDATE
  USING (EXISTS (SELECT 1 FROM public.characters c
                 WHERE c.id = character_id AND c.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.characters c
                      WHERE c.id = character_id AND c.user_id = auth.uid()));

CREATE POLICY "templates_delete" ON public.templates
  FOR DELETE USING (
    public.is_admin() OR
    EXISTS (SELECT 1 FROM public.characters c
            WHERE c.id = character_id AND c.user_id = auth.uid())
  );

-- ── user_library policies ────────────────────────────────────

CREATE POLICY "user_library_select" ON public.user_library
  FOR SELECT USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "user_library_insert" ON public.user_library
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_library_update" ON public.user_library
  FOR UPDATE
  USING    (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_library_delete" ON public.user_library
  FOR DELETE USING (user_id = auth.uid() OR public.is_admin());

-- ── board_library policies ───────────────────────────────────

-- All authenticated users can read
CREATE POLICY "board_library_select" ON public.board_library
  FOR SELECT TO authenticated USING (true);

-- Only admins can write
CREATE POLICY "board_library_insert" ON public.board_library
  FOR INSERT WITH CHECK (public.is_admin());

CREATE POLICY "board_library_update" ON public.board_library
  FOR UPDATE
  USING    (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "board_library_delete" ON public.board_library
  FOR DELETE USING (public.is_admin());

-- ── backup_log policies ──────────────────────────────────────

-- Any authenticated user can log a backup
CREATE POLICY "backup_log_insert" ON public.backup_log
  FOR INSERT TO authenticated WITH CHECK (true);

-- Users see only their own entries; admins see all
CREATE POLICY "backup_log_select" ON public.backup_log
  FOR SELECT USING (triggered_by = auth.uid()::text OR public.is_admin());
