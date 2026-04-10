-- ============================================================
-- RLS Audit Script
-- Run this entire file in the Supabase SQL Editor.
-- All test data is rolled back at the end — nothing persists.
--
-- Uses fixed UUIDs so re-runs are idempotent.
-- Prints [PASS] / [FAIL] via RAISE NOTICE.
-- ============================================================

BEGIN;

DO $$
DECLARE
  -- Fixed test UUIDs (easy to search/clean up if needed)
  v_user_a  uuid := '11111111-1111-1111-1111-111111111111';
  v_user_b  uuid := '22222222-2222-2222-2222-222222222222';
  v_admin   uuid := '33333333-3333-3333-3333-333333333333';
  v_char_b  uuid := '44444444-4444-4444-4444-444444444444';
  v_bl_id   uuid := '55555555-5555-5555-5555-555555555555';

  v_cnt      bigint;
  v_inserted bool;
  v_pass     int := 0;
  v_fail     int := 0;
BEGIN

  -- ── Seed test data (runs as postgres → bypasses RLS) ─────────────
  INSERT INTO public.users (id, username, role) VALUES
    (v_user_a, '_audit_user_a', 'user'),
    (v_user_b, '_audit_user_b', 'user'),
    (v_admin,  '_audit_admin',  'admin')
  ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, role = EXCLUDED.role;

  INSERT INTO public.characters (id, user_id, name) VALUES
    (v_char_b, v_user_b, '_audit_char_b')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.board_library (id, trigger, replacement_html, added_by) VALUES
    (v_bl_id, '_audit_trigger', '<b>test</b>', v_admin)
  ON CONFLICT (id) DO NOTHING;

  RAISE NOTICE '── RLS Audit Agent starting (4 tests) ──────────────────';

  -- ════════════════════════════════════════════════════════════
  -- Test 1: User A cannot SELECT User B's characters
  -- ════════════════════════════════════════════════════════════
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"' || v_user_a || '","role":"authenticated"}',
    true
  );
  SET LOCAL ROLE authenticated;

  SELECT COUNT(*) INTO v_cnt
  FROM public.characters
  WHERE user_id = v_user_b;

  RESET ROLE;

  IF v_cnt = 0 THEN
    v_pass := v_pass + 1;
    RAISE NOTICE '[PASS] Test 1: User A cannot SELECT User B''s characters';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE '[FAIL] Test 1: User A saw % row(s) from User B (expected 0)', v_cnt;
  END IF;

  -- ════════════════════════════════════════════════════════════
  -- Test 2: User A cannot INSERT into User B's templates
  -- ════════════════════════════════════════════════════════════
  v_inserted := false;

  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"' || v_user_a || '","role":"authenticated"}',
    true
  );

  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.templates (id, character_id, name)
    VALUES (gen_random_uuid(), v_char_b, '_audit_tmpl_fail');
    -- Reaching this line means RLS did NOT block the insert
    v_inserted := true;
  EXCEPTION WHEN OTHERS THEN
    -- Expected: "new row violates row-level security policy"
    v_inserted := false;
  END;

  RESET ROLE;

  IF NOT v_inserted THEN
    v_pass := v_pass + 1;
    RAISE NOTICE '[PASS] Test 2: User A cannot INSERT into User B''s templates';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE '[FAIL] Test 2: User A was able to INSERT into User B''s templates';
  END IF;

  -- ════════════════════════════════════════════════════════════
  -- Test 3: Non-admin cannot UPDATE board_library
  -- RLS silently blocks updates on rows you cannot see,
  -- so we check that used_by_count did not change.
  -- ════════════════════════════════════════════════════════════
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"' || v_user_a || '","role":"authenticated"}',
    true
  );
  SET LOCAL ROLE authenticated;

  UPDATE public.board_library
  SET used_by_count = 999
  WHERE id = v_bl_id;

  RESET ROLE;

  -- Read back as postgres (bypasses RLS) to see the real value
  SELECT used_by_count INTO v_cnt
  FROM public.board_library
  WHERE id = v_bl_id;

  IF COALESCE(v_cnt, 0) <> 999 THEN
    v_pass := v_pass + 1;
    RAISE NOTICE '[PASS] Test 3: Non-admin cannot UPDATE board_library (value unchanged)';
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE '[FAIL] Test 3: Non-admin changed used_by_count to 999';
  END IF;

  -- ════════════════════════════════════════════════════════════
  -- Test 4: Admin can SELECT all rows in characters
  -- ════════════════════════════════════════════════════════════
  PERFORM set_config(
    'request.jwt.claims',
    '{"sub":"' || v_admin || '","role":"authenticated"}',
    true
  );
  SET LOCAL ROLE authenticated;

  SELECT COUNT(*) INTO v_cnt FROM public.characters;

  RESET ROLE;

  IF v_cnt > 0 THEN
    v_pass := v_pass + 1;
    RAISE NOTICE '[PASS] Test 4: Admin can SELECT all characters (found % row(s))', v_cnt;
  ELSE
    v_fail := v_fail + 1;
    RAISE NOTICE '[FAIL] Test 4: Admin saw 0 rows in characters (expected >= 1)';
  END IF;

  -- ── Summary ───────────────────────────────────────────────────────
  RAISE NOTICE '─────────────────────────────────────────────────────────';
  RAISE NOTICE 'Result: %/4 passed  |  %/4 failed', v_pass, v_fail;

  IF v_fail > 0 THEN
    RAISE EXCEPTION 'Audit FAILED: % test(s) did not pass. Review FAIL lines above.', v_fail;
  ELSE
    RAISE NOTICE 'All 4 RLS tests passed.';
  END IF;

END;
$$ LANGUAGE plpgsql;

ROLLBACK;  -- Discard all test data; RAISE NOTICE output is already visible
