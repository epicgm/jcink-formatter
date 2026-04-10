-- ============================================================
-- RLS Audit Script  —  paste into Supabase SQL Editor and Run
-- Results appear as rows in the Results tab.
-- Test data is deleted at the end of the DO block.
-- ============================================================

-- Collect results here
DROP TABLE IF EXISTS _rls_audit;
CREATE TEMP TABLE _rls_audit (
  num         int,
  result      text,   -- PASS | FAIL
  description text,
  detail      text
);

DO $$
DECLARE
  v_user_a  uuid := '11111111-1111-1111-1111-111111111111';
  v_user_b  uuid := '22222222-2222-2222-2222-222222222222';
  v_admin   uuid := '33333333-3333-3333-3333-333333333333';
  v_char_b  uuid := '44444444-4444-4444-4444-444444444444';
  v_bl_id   uuid := '55555555-5555-5555-5555-555555555555';

  v_cnt      bigint;
  v_inserted bool;
BEGIN

  -- ── Seed test data (postgres role → bypasses RLS) ────────────────
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

  -- ════════════════════════════════════════════════════════════════
  -- Test 1: User A cannot SELECT User B's characters
  -- ════════════════════════════════════════════════════════════════
  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || v_user_a || '","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;

  SELECT COUNT(*) INTO v_cnt FROM public.characters WHERE user_id = v_user_b;

  RESET ROLE;

  INSERT INTO _rls_audit VALUES (
    1,
    CASE WHEN v_cnt = 0 THEN 'PASS' ELSE 'FAIL' END,
    'User A cannot SELECT User B''s characters',
    CASE WHEN v_cnt = 0
      THEN 'Returned 0 rows as expected'
      ELSE 'Returned ' || v_cnt || ' row(s) — policy not blocking'
    END
  );

  -- ════════════════════════════════════════════════════════════════
  -- Test 2: User A cannot INSERT into User B's templates
  -- ════════════════════════════════════════════════════════════════
  v_inserted := false;

  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || v_user_a || '","role":"authenticated"}', true);

  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO public.templates (id, character_id, name)
    VALUES (gen_random_uuid(), v_char_b, '_audit_tmpl_fail');
    v_inserted := true;   -- only reaches here if RLS did NOT block
  EXCEPTION WHEN OTHERS THEN
    v_inserted := false;  -- RLS violation caught — expected
  END;

  RESET ROLE;

  INSERT INTO _rls_audit VALUES (
    2,
    CASE WHEN NOT v_inserted THEN 'PASS' ELSE 'FAIL' END,
    'User A cannot INSERT into User B''s templates',
    CASE WHEN NOT v_inserted
      THEN 'INSERT blocked by RLS as expected'
      ELSE 'INSERT succeeded — policy not blocking'
    END
  );

  -- ════════════════════════════════════════════════════════════════
  -- Test 3: Non-admin cannot UPDATE board_library
  -- ════════════════════════════════════════════════════════════════
  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || v_user_a || '","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;

  UPDATE public.board_library SET used_by_count = 999 WHERE id = v_bl_id;

  RESET ROLE;

  -- Read back as postgres to see the real stored value
  SELECT used_by_count INTO v_cnt FROM public.board_library WHERE id = v_bl_id;

  INSERT INTO _rls_audit VALUES (
    3,
    CASE WHEN COALESCE(v_cnt, 0) <> 999 THEN 'PASS' ELSE 'FAIL' END,
    'Non-admin cannot UPDATE board_library',
    CASE WHEN COALESCE(v_cnt, 0) <> 999
      THEN 'UPDATE silently blocked (used_by_count unchanged)'
      ELSE 'used_by_count changed to 999 — policy not blocking'
    END
  );

  -- ════════════════════════════════════════════════════════════════
  -- Test 4: Admin can SELECT all rows in characters
  -- ════════════════════════════════════════════════════════════════
  PERFORM set_config('request.jwt.claims',
    '{"sub":"' || v_admin || '","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;

  SELECT COUNT(*) INTO v_cnt FROM public.characters;

  RESET ROLE;

  INSERT INTO _rls_audit VALUES (
    4,
    CASE WHEN v_cnt > 0 THEN 'PASS' ELSE 'FAIL' END,
    'Admin can SELECT all rows in characters',
    CASE WHEN v_cnt > 0
      THEN 'Admin saw ' || v_cnt || ' row(s) as expected'
      ELSE 'Admin saw 0 rows — is_admin() or policy broken'
    END
  );

  -- ── Clean up test data ────────────────────────────────────────────
  DELETE FROM public.board_library WHERE id = v_bl_id;
  DELETE FROM public.characters   WHERE id = v_char_b;
  DELETE FROM public.users        WHERE id IN (v_user_a, v_user_b, v_admin);

END;
$$ LANGUAGE plpgsql;

-- ── Show results ──────────────────────────────────────────────────
SELECT
  num                                          AS "#",
  result,
  description                                  AS test,
  detail
FROM _rls_audit
ORDER BY num;
