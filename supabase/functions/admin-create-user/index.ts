/**
 * admin-create-user — Supabase Edge Function
 *
 * Receives: { username: string, password: string, role: 'user'|'admin' }
 * Creates a Supabase auth user + public.users profile row.
 * Caller must be an admin (role verified against public.users).
 *
 * Deploy:
 *   supabase functions deploy admin-create-user
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // Service-role client — bypasses RLS, used for everything including auth verify
  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // ── 1. Verify caller JWT ──────────────────────────────────────────────────
  // Use serviceClient.auth.getUser(token) — does not depend on SUPABASE_ANON_KEY,
  // which can differ between auto-injected and custom secret values.
  const authHeader = req.headers.get('Authorization') ?? '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '');

  if (!accessToken) return json({ error: 'Unauthorized — no token.' }, 401);

  const { data: { user: caller }, error: authErr } = await serviceClient.auth.getUser(accessToken);
  if (authErr || !caller) return json({ error: 'Unauthorized — invalid token.' }, 401);

  // ── 2. Verify caller is admin ─────────────────────────────────────────────
  const { data: callerProfile, error: profileErr } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single();

  if (profileErr) return json({ error: `Could not verify role: ${profileErr.message}` }, 500);
  if (callerProfile?.role !== 'admin') return json({ error: 'Forbidden — admin only.' }, 403);

  // ── 3. Parse body ─────────────────────────────────────────────────────────
  let username = '', password = '', role = 'user';
  try {
    const body = await req.json();
    username = (body.username ?? '').trim();
    password = (body.password ?? '').trim();
    role     = ['admin', 'user'].includes(body.role) ? body.role : 'user';
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  if (!username || !password) {
    return json({ error: '"username" and "password" are required.' }, 400);
  }

  // ── 4. Create auth user ───────────────────────────────────────────────────
  const { data: authData, error: createErr } = await serviceClient.auth.admin.createUser({
    email:         username,
    password,
    email_confirm: true,  // skip email verification — admin-created accounts are pre-approved
  });

  if (createErr) return json({ error: createErr.message }, 400);

  // ── 5. Insert public.users row ────────────────────────────────────────────
  const { error: insertErr } = await serviceClient.from('users').insert({
    id:       authData.user.id,
    username,
    role,
  });

  if (insertErr) {
    // Roll back the auth user to avoid orphaned records
    await serviceClient.auth.admin.deleteUser(authData.user.id);
    return json({ error: `Profile insert failed: ${insertErr.message}` }, 500);
  }

  return json({ id: authData.user.id, username, role });
});
