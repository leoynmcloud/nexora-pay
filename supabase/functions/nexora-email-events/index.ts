import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const htmlEntities: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};
const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (char) => htmlEntities[char]);

function template(title: string, intro: string, details: Array<[string, string]>, note: string) {
  const rows = details.map(([label, value]) => `<tr><td style="padding:9px 0;color:#6b6877;font-size:13px">${escapeHtml(label)}</td><td style="padding:9px 0;color:#211d2b;font-size:13px;text-align:right;font-weight:600">${escapeHtml(value)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;padding:28px 12px;background:#f4f3f8;font-family:Arial,Helvetica,sans-serif;color:#211d2b"><div style="max-width:560px;margin:auto;background:#fff;border:1px solid #e5e1ed;border-radius:16px;overflow:hidden"><div style="padding:21px 26px;border-bottom:1px solid #eeeaf3;font-size:20px;font-weight:700">Nexora <span style="color:#7c3aed">Pay</span></div><div style="padding:28px 26px"><div style="font-size:11px;letter-spacing:1.3px;color:#7540dd;font-weight:700">AVISO DA SUA CONTA</div><h1 style="font-size:24px;line-height:1.25;margin:12px 0;color:#211d2b">${escapeHtml(title)}</h1><p style="font-size:15px;line-height:1.65;color:#625d70">${escapeHtml(intro)}</p>${rows ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:20px 0;border-top:1px solid #eeeaf3;border-bottom:1px solid #eeeaf3">${rows}</table>` : ''}<p style="font-size:13px;line-height:1.6;color:#625d70">${escapeHtml(note)}</p><p style="margin:24px 0 0"><a href="https://www.nexorapay.me/platform.html" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700">Acessar Nexora Pay</a></p></div><div style="padding:15px 26px;background:#faf9fc;color:#777184;font-size:11px">Mensagem automática. Não responda com senhas, códigos ou dados bancários.</div></div></body></html>`;
  const text = `${title}\n\n${intro}\n${details.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${note}\n\nhttps://www.nexorapay.me/platform.html`;
  return { html, text };
}

async function sendEmail(to: string, subject: string, content: { html: string; text: string }, idempotencyKey: string) {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('RESEND_FROM');
  const replyTo = Deno.env.get('RESEND_REPLY_TO');
  if (!apiKey || !from) throw new Error('Resend ainda não está configurado no servidor.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey.slice(0, 256),
    },
    body: JSON.stringify({ from, to: [to], subject, html: content.html, text: content.text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Resend rejected email', response.status, result?.name || result?.statusCode || 'unknown');
    throw new Error('Resend não aceitou o envio. Confira remetente/domínio e configuração da chave.');
  }
  return String(result.id || 'accepted');
}

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') || '';
  const defaults = ['http://localhost:4173', 'http://127.0.0.1:4173', 'https://nexorapay.me', 'https://www.nexorapay.me'];
  const deprecatedOrigins = new Set(['https://nexorapay-demo.vercel.app']);
  const custom = (Deno.env.get('NEXORA_ALLOWED_ORIGINS') || '').split(',').map((value) => value.trim()).filter((value) => value && !deprecatedOrigins.has(value));
  const allowed = [...new Set([...defaults, ...custom])];
  const cors = { ...corsHeaders, 'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0], Vary: 'Origin' };
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (origin && !allowed.includes(origin)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403, headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers: cors });
  if (Number(request.headers.get('content-length') || 0) > 8192) return Response.json({ error: 'Solicitação muito grande.' }, { status: 413, headers: cors });

  try {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return Response.json({ error: 'Sessão necessária.' }, { status: 401, headers: cors });
    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    if (!url || !anonKey || !serviceKey) throw new Error('Supabase não configurado no servidor.');

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return Response.json({ error: 'Sessão inválida ou expirada.' }, { status: 401, headers: cors });
    const caller = authData.user;
    const rawBody = await readBoundedHttpBody(request, 8_192);
    if (rawBody === null) return Response.json({ error: 'Solicitação muito grande ou inválida.' }, { status: 413, headers: cors });
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
      input = parsed as Record<string, unknown>;
    } catch { return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers: cors }); }
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const emailIds: string[] = [];

    if (input.type === 'email_test') {
      const { data: isAdmin, error: adminCheckError } = await userClient.rpc('is_nexora_super_admin');
      if (adminCheckError || isAdmin !== true) return Response.json({ error: 'Ação restrita ao super admin.' }, { status: 403, headers: cors });
      if (!caller.email) return Response.json({ error: 'A conta não possui e-mail para receber o teste.' }, { status: 422, headers: cors });
      const name = String(caller.user_metadata?.full_name || caller.email.split('@')[0]);
      const content = template('Configuração de e-mails ativa', `${name}, este é um teste do envio automático da Nexora Pay.`, [],
        'Nenhum cadastro, pagamento ou transferência foi criado ou alterado por este teste.');
      emailIds.push(await sendEmail(caller.email, '[TESTE] E-mails da Nexora Pay', content,
        `nexora/email-test/${caller.id}/${crypto.randomUUID()}`));
    } else if (input.type === 'kyc_decision') {
      const { data: isAdmin, error: adminCheckError } = await userClient.rpc('is_nexora_super_admin');
      if (adminCheckError || isAdmin !== true) return Response.json({ error: 'Ação restrita ao super admin.' }, { status: 403, headers: cors });
      const userId = String(input.user_id || '');
      if (!/^[0-9a-f-]{36}$/i.test(userId)) return Response.json({ error: 'Cadastro inválido.' }, { status: 400, headers: cors });
      const { data: onboarding, error: onboardingError } = await admin.from('merchant_onboarding')
        .select('status,reason_description').eq('user_id', userId).maybeSingle();
      if (onboardingError) throw onboardingError;
      const status = String(onboarding?.status || '');
      const configByStatus: Record<string, { subject: string; title: string; intro: string; note: string }> = {
        APPROVED: { subject: 'Cadastro aprovado | Nexora Pay', title: 'Seu cadastro foi aprovado', intro: 'A análise dos seus dados foi concluída e seu cadastro está aprovado.', note: 'Você já pode entrar na plataforma. A disponibilidade de pagamentos depende da integração e homologação do adquirente.' },
        REJECTED: { subject: 'Atualização do cadastro | Nexora Pay', title: 'Seu cadastro não foi aprovado', intro: 'Concluímos a análise e, neste momento, não foi possível aprovar o cadastro.', note: onboarding?.reason_description || 'Entre na plataforma para consultar as orientações da equipe Nexora Pay.' },
        PENDING_DOCUMENTS: { subject: 'Ajustes necessários no cadastro | Nexora Pay', title: 'Precisamos de ajustes no seu cadastro', intro: 'A análise identificou informações ou documentos que precisam de correção.', note: onboarding?.reason_description || 'Acesse a plataforma para verificar o que precisa ser atualizado e reenviar o cadastro.' },
      };
      const config = configByStatus[status];
      if (!config) return Response.json({ error: 'O cadastro ainda não possui uma decisão de e-mail compatível.' }, { status: 409, headers: cors });
      const { data: review, error: reviewError } = await admin.from('merchant_kyc_reviews').select('id,to_status,reviewer_id,reason')
        .eq('user_id', userId).eq('reviewer_id', caller.id).eq('to_status', status).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (reviewError) throw reviewError;
      if (!review) return Response.json({ error: 'Não foi encontrada a decisão registrada por esta sessão.' }, { status: 403, headers: cors });
      const { data: authUser, error: authUserError } = await admin.auth.admin.getUserById(userId);
      if (authUserError) throw authUserError;
      const recipient = authUser.user?.email;
      if (!recipient) return Response.json({ error: 'A conta não possui e-mail para receber o aviso.' }, { status: 422, headers: cors });
      const name = String(authUser.user?.user_metadata?.full_name || recipient.split('@')[0]);
      const note = status === 'APPROVED' ? config.note : (review.reason || config.note);
      const content = template(config.title, `${name}, ${config.intro}`, [], note);
      emailIds.push(await sendEmail(recipient, config.subject, content, `nexora/kyc/${review.id}`));
    } else {
      return Response.json({ error: 'Tipo de aviso desconhecido.' }, { status: 400, headers: cors });
    }

    return Response.json({ ok: true, sent: emailIds.length }, { status: 200, headers: cors });
  } catch (error) {
    console.error('nexora-email-events failed', error instanceof Error ? error.name : 'unknown');
    const message = error instanceof Error && error.message.startsWith('Resend') ? error.message : 'Não foi possível enviar o aviso. Verifique a configuração do Supabase e do Resend.';
    return Response.json({ error: message }, { status: 500, headers: cors });
  }
});
