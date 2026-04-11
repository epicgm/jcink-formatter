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
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  // Caller-scoped client (respects RLS, uses caller's JWT)
  const authHeader = req.headers.get('Authorization') ?? '';
  const callerClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );

  // Service-role client (bypasses RLS — only used after admin verified)
  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Verify caller is authenticated
  const { data: { user: caller }, error: sessionErr } = await callerClient.auth.getUser();
  if (sessionErr || !caller) return json({ error: 'Unauthorized' }, 401);

  // Verify caller has admin role
  const { data: profile } = await serviceClient
    .from('users')
    .select('role')
    .eq('id', caller.id)
    .single();

  if (profile?.role !== 'admin') return json({ error: 'Forbidden — admin only.' }, 403);

  // Parse request
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

  // Create Supabase auth user (username used as email)
  const { data: authData, error: authErr } = await serviceClient.auth.admin.createUser({
    email:          username,
    password,
    email_confirm:  true,   // skip email verification
  });

  if (authErr) return json({ error: authErr.message }, 400);

  // Insert into public.users
  const { error: profileErr } = await serviceClient.from('users').insert({
    id:       authData.user.id,
    username,
    role,
  });

  if (profileErr) {
    // Roll back the auth user to avoid orphaned records
    await serviceClient.auth.admin.deleteUser(authData.user.id);
    return json({ error: profileErr.message }, 500);
  }

  return json({ id: authData.user.id, username, role });
});
