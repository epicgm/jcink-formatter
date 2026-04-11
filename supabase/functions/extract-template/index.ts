/**
 * extract-template — Supabase Edge Function
 *
 * Receives: { template: string }  (raw Jcink template HTML/BBCode from browser)
 * Sends ONE request to Claude API (claude-sonnet-4-6)
 * Returns: { shell_html, rules, unknown_patterns }
 * Logs: backup_log entry with triggered_by='extraction' and status='success'|'failed'
 *
 * Prerequisites:
 *   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
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
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  // Check API key present
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return json({ error: 'ANTHROPIC_API_KEY is not set in Supabase secrets.' }, 500);
  }

  // Supabase client (service role so backup_log insert bypasses RLS)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Parse request body
  let template = '';
  try {
    const body = await req.json();
    template = (body.template ?? '').trim();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  if (!template) {
    return json({ error: '"template" field is required.' }, 400);
  }

  // ── Single Claude API call ───────────────────────────────────────────────────
  let logStatus = 'failed';

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: 'You are a Jcink template parser. Return only valid JSON, no other text.',
        messages: [{
          role: 'user',
          content: `Parse this Jcink template and return JSON matching exactly this structure:

{
  "shell_html": string,
  "rules": [
    {
      "type": string,
      "opening_marker": string,
      "closing_marker": string,
      "bold": boolean,
      "italic": boolean,
      "color": string | null
    }
  ],
  "unknown_patterns": string[]
}

Rules:
- shell_html: the full template with the post body area replaced by the literal placeholder string {{content}}
- rules: inline text-formatting patterns you detect. "type" must be one of: "dialogue", "thought", "action", "narration", "other"
  * dialogue  = spoken words, typically wrapped in double-quotes and styling
  * thought   = internal monologue, typically in single-quotes or italics
  * action    = physical action lines
  * narration = descriptive prose with distinct styling
  * other     = any other classified pattern
- opening_marker / closing_marker: the exact BBCode or HTML that wraps the text, including any quote characters that are part of the style
- bold / italic: true if [b] or [i] (or <b>/<i>) appear in the markers
- color: CSS color string if a color tag is present, otherwise null
- unknown_patterns: any BBCode tags or HTML patterns you cannot classify into a rule type

Template:
${template}`,
        }],
      }),
    });

    const claudeData = await claudeRes.json();

    if (!claudeRes.ok) {
      throw new Error(claudeData.error?.message ?? `Claude API ${claudeRes.status}`);
    }

    const raw = (claudeData.content?.[0]?.text ?? '').trim();

    // Strip markdown code fences if present
    const fenceMatch = raw.match(/```(?:json)?\n?([\s\S]*?)```/);
    const jsonStr = fenceMatch ? fenceMatch[1].trim() : raw;

    const result = JSON.parse(jsonStr);
    logStatus = 'success';

    // ── Log to backup_log ──────────────────────────────────────────────────────
    await supabase.from('backup_log').insert({
      triggered_by: 'extraction',
      status: 'success',
    });

    return json(result);

  } catch (err) {
    // Log failure before returning
    await supabase.from('backup_log').insert({
      triggered_by: 'extraction',
      status: 'failed',
    });

    return json({ error: String(err) }, 500);
  }
});
