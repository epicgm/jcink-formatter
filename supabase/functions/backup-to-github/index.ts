/**
 * backup-to-github — Supabase Edge Function
 *
 * Triggered by a Supabase Database Webhook on INSERT/UPDATE to
 * the `characters` or `templates` tables.
 *
 * Webhook setup (Supabase Dashboard → Database → Webhooks):
 *   Table:  characters  (INSERT, UPDATE, DELETE)
 *   Table:  templates   (INSERT, UPDATE, DELETE)
 *   URL:    https://<project-ref>.supabase.co/functions/v1/backup-to-github
 *   Secret: (optionally set WEBHOOK_SECRET and verify below)
 *
 * Secrets required (supabase secrets set ...):
 *   GITHUB_TOKEN  — personal access token with repo write scope
 *   GITHUB_REPO   — "owner/repo" of the private backup repository
 *
 * Output: commits backups/<filename>.json to the GitHub repo and
 *         logs the result to public.backup_log.
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

// ── GitHub commit helper ──────────────────────────────────────────────────────

async function commitToGitHub(
  token:   string,
  repo:    string,
  path:    string,
  content: string,
  message: string,
): Promise<void> {
  // btoa only handles Latin-1; encode UTF-8 → Uint8Array → base64
  const bytes   = new TextEncoder().encode(content);
  const binStr  = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
  const encoded = btoa(binStr);

  // Check if file already exists to get its SHA (required for update)
  let sha: string | undefined;
  const check = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'inkform-backup',
      },
    },
  );
  if (check.ok) {
    const existing = await check.json();
    sha = existing.sha;
  }

  const body: Record<string, unknown> = { message, content: encoded };
  if (sha) body.sha = sha;

  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method:  'PUT',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'inkform-backup',
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub ${res.status}: ${errText}`);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const GITHUB_TOKEN = Deno.env.get('GITHUB_TOKEN');
  const GITHUB_REPO  = Deno.env.get('GITHUB_REPO');

  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    return json({ error: 'GITHUB_TOKEN and GITHUB_REPO secrets are required.' }, 500);
  }

  const serviceClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const filename = [
    'backup',
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`,
    `${pad(now.getUTCHours())}-${pad(now.getUTCMinutes())}`,
  ].join('_') + '.json';

  let logStatus = 'success';
  let logDetail = `backups/${filename}`;

  try {
    // ── Fetch full snapshot ───────────────────────────────────────────────────

    const [
      { data: users },
      { data: characters },
      { data: templates },
      { data: userLibrary },
      { data: boardLibrary },
    ] = await Promise.all([
      serviceClient.from('users')
        .select('id, username, role, created_at, active')
        .order('username'),
      serviceClient.from('characters')
        .select('id, user_id, name, created_at')
        .order('name'),
      serviceClient.from('templates')
        .select('id, character_id, name, shell_html, rules_json, active_block_ids, created_at')
        .order('name'),
      serviceClient.from('user_library')
        .select('id, user_id, trigger, replacement_html, is_global, forked_from, board_source_id')
        .order('trigger'),
      serviceClient.from('board_library')
        .select('id, trigger, replacement_html, added_by, status, used_by_count')
        .order('trigger'),
    ]);

    // ── Nest templates under characters ──────────────────────────────────────

    type Template = typeof templates extends (infer T)[] | null ? T : never;
    type Character = typeof characters extends (infer T)[] | null ? T : never;
    type LibBlock  = typeof userLibrary extends (infer T)[] | null ? T : never;

    const tmplsByChar: Record<string, (Template & { templates?: Template[] })[]> = {};
    for (const t of templates ?? []) {
      (tmplsByChar[(t as Template & { character_id: string }).character_id] ??= []).push(t as Template);
    }

    const charsByUser: Record<string, unknown[]> = {};
    for (const c of characters ?? []) {
      const char = { ...(c as Character), templates: tmplsByChar[(c as Character & { id: string }).id] ?? [] };
      (charsByUser[(c as Character & { user_id: string }).user_id] ??= []).push(char);
    }

    const libByUser: Record<string, LibBlock[]> = {};
    for (const b of userLibrary ?? []) {
      (libByUser[(b as LibBlock & { user_id: string }).user_id] ??= []).push(b as LibBlock);
    }

    // ── Build snapshot ────────────────────────────────────────────────────────

    const snapshot = {
      exported_at:   now.toISOString(),
      users: (users ?? []).map(u => ({
        ...u,
        characters:   charsByUser[(u as typeof u & { id: string }).id]  ?? [],
        user_library: libByUser[(u as typeof u & { id: string }).id]    ?? [],
      })),
      board_library: boardLibrary ?? [],
    };

    // ── Commit to GitHub ──────────────────────────────────────────────────────

    await commitToGitHub(
      GITHUB_TOKEN,
      GITHUB_REPO,
      `backups/${filename}`,
      JSON.stringify(snapshot, null, 2),
      `backup: ${filename}`,
    );

  } catch (err) {
    logStatus = 'failed';
    logDetail  = err instanceof Error ? err.message : String(err);
    console.error('[backup-to-github]', logDetail);
  }

  // ── Log result ────────────────────────────────────────────────────────────

  await serviceClient.from('backup_log').insert({
    triggered_by: 'webhook',
    status:       logStatus,
    detail:       logDetail,
  });

  return logStatus === 'failed'
    ? json({ error: logDetail }, 500)
    : json({ ok: true, filename });
});
