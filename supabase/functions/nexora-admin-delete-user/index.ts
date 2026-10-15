import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readBoundedHttpBody } from '../_shared/bounded-http-body.ts';

const origins = ['https://nexorapay.me', 'https://www.nexorapay.me'];
const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') || '';
  const cors = { ...corsHeaders, 'Access-Control-Allow-Origin': origins.includes(origin) ? origin : origins[1], Vary: 'Origin' };
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Método não permitido.' }, { status: 405, headers: cors });

  try {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return Response.json({ error: 'Sessão necessária.' }, { status: 401, headers: cors });
    const url = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !anonKey || !serviceKey) throw new Error('Configuração do servidor incompleta.');

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: auth, error: authError } = await userClient.auth.getUser(token);
    if (authError || !auth.user) return Response.json({ error: 'Sessão inválida ou expirada.' }, { status: 401, headers: cors });

    const { data: assurance, error: assuranceError } = await userClient.auth.mfa.getAuthenticatorAssuranceLevel(token);
    if (assuranceError) {
      return Response.json({ error: 'Falha ao validar nível de autenticação.' }, { status: 403, headers: cors });
    }

    const { data: isAdmin, error: adminCheckError } = await userClient.rpc('is_nexora_super_admin');
    if (adminCheckError || isAdmin !== true) return Response.json({ error: 'Ação restrita ao super admin.' }, { status: 403, headers: cors });

    const rawBody = await readBoundedHttpBody(request, 8_192);
    if (rawBody === null) return Response.json({ error: 'Solicitação muito grande ou inválida.' }, { status: 413, headers: cors });
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_body');
      input = parsed as Record<string, unknown>;
    } catch { return Response.json({ error: 'Solicitação inválida.' }, { status: 400, headers: cors }); }
    const userId = String(input.user_id || '');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return Response.json({ error: 'Conta inválida.' }, { status: 400, headers: cors });
    if (userId === auth.user.id) return Response.json({ error: 'Não é possível remover a própria conta administrativa.' }, { status: 400, headers: cors });

    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: target, error: targetError } = await admin.auth.admin.getUserById(userId);
    if (targetError || !target.user) return Response.json({ error: 'Conta não encontrada.' }, { status: 404, headers: cors });
    const targetEmail = String(target.user.email || '');
    if (!targetEmail) return Response.json({ error: 'A conta não possui e-mail para confirmar a remoção.' }, { status: 422, headers: cors });
    const { data: adminMatch, error: adminMatchError } = await admin.from('nexora_admins').select('email').ilike('email', targetEmail).limit(1);
    if (adminMatchError) throw adminMatchError;
    if (adminMatch?.length) return Response.json({ error: 'Contas administrativas não podem ser removidas por esta ação.' }, { status: 403, headers: cors });

    const { data: documents, error: documentsError } = await admin.from('merchant_kyc_documents').select('storage_path').eq('user_id', userId);
    if (documentsError) throw documentsError;
    const paths = (documents || []).map((document) => String(document.storage_path || '')).filter(Boolean);
    const { error: auditError } = await admin.from('nexora_audit_log').insert({
      actor_id: auth.user.id,
      action: 'account.removal_started',
      target_id: userId,
      details: { operation: 'hard_delete' },
    });
    if (auditError) throw auditError;

    const { error: purgeError } = await admin.rpc('nexora_admin_purge_account', { p_user_id: userId });
    if (purgeError) {
      console.error('nexora-admin-delete-user purge failed', purgeError);
      return Response.json({ error: purgeError.message || 'Não foi possível expurgar os registros da conta.' }, { status: 400, headers: cors });
    }

    const { error: deleteError } = await admin.auth.admin.deleteUser(userId, false);
    if (deleteError) {
      console.error('nexora-admin-delete-user auth deletion failed', deleteError.code || 'unknown', deleteError.message);
      throw new Error(deleteError.code === '23503'
        ? 'A conta ainda possui dados vinculados sem regra de exclusão. O login foi preservado; é necessário corrigir o vínculo no banco antes de tentar novamente.'
        : `O Supabase não concluiu a exclusão: ${deleteError.message}`);
    }
    let documentsRemoved = true;
    if (paths.length) {
      const { error: storageError } = await admin.storage.from('nexora-kyc').remove(paths);
      documentsRemoved = !storageError;
      if (storageError) console.warn('Conta excluída; a limpeza de alguns documentos privados falhou.');
    }
    const { error: completedAuditError } = await admin.from('nexora_audit_log').insert({
      actor_id: auth.user.id,
      action: 'account.removed',
      target_id: userId,
      details: { operation: 'hard_delete', documents_removed: documentsRemoved },
    });
    if (completedAuditError) console.warn('Conta removida; não foi possível registrar o evento final de auditoria.');
    return Response.json({ ok: true, audit_logged: !completedAuditError, documents_removed: documentsRemoved }, { status: 200, headers: cors });
  } catch (error) {
    console.error('nexora-admin-delete-user failed', error instanceof Error ? error.name : 'unknown');
    return Response.json({ error: error instanceof Error ? error.message : 'Não foi possível remover a conta.' }, { status: 500, headers: cors });
  }
});
