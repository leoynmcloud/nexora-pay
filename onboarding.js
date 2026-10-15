(function () {
  'use strict';
  const client = window.nexoraSupabase, form = document.querySelector('[data-kyc-form]');
  const statusBox = document.querySelector('[data-kyc-status]'), formMessage = document.querySelector('[data-kyc-form-message]');
  // Authenticated users may submit onboarding for immediate approval and operation.
  const ACCEPTING_KYC_SUBMISSIONS = true;
  const statusText = {DRAFT:'Preencha os dados abaixo para enviar sua conta para análise.',SUBMITTED:'Cadastro enviado com sucesso! Seus dados estão em análise pela equipe da Nexora.',UNDER_REVIEW:'Seu cadastro está em análise pela equipe da Nexora.',MANUAL_REVIEW:'Seu cadastro está em análise pela equipe da Nexora.',PENDING_DOCUMENTS:'Precisamos de ajustes nos dados para continuar.',REJECTED:'Não foi possível aprovar o cadastro. Verifique as informações para reenviar.',APPROVED:'Conta ativada com sucesso! Abrindo sua operação…',SUSPENDED:'Conta suspensa. Fale com o suporte.',BLOCKED:'Conta bloqueada. Fale com o suporte.',CLOSED:'Conta encerrada.'};
  let user, existingDocuments = [];
  const setStatus = (text, kind = '') => { statusBox.textContent = text; statusBox.dataset.kind = kind; };
  const message = text => { formMessage.textContent = text || ''; };
  async function requireMfaForKycSubmission() {
    const { data: factorData, error: factorsError } = await client.auth.mfa.listFactors();
    if (factorsError) throw factorsError;
    let factor = (factorData?.totp || []).find(item => item.status === 'verified');
    let setup = false, enrollment = null;
    if (!factor) {
      for (const pending of (factorData?.totp || []).filter(item => item.status !== 'verified')) {
        const { error } = await client.auth.mfa.unenroll({ factorId: pending.id });
        if (error) throw error;
      }
      const { data, error } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Nexora Pay' });
      if (error) throw error;
      if (!data?.id || !data.totp?.qr_code || !data.totp?.secret) throw new Error('Não foi possível iniciar a configuração do autenticador.');
      enrollment = data;
      factor = { id: data.id };
      setup = true;
    }
    const { data: assurance, error: assuranceError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError) throw assuranceError;
    if (!setup && assurance?.currentLevel === 'aal2') return true;

    const content = `<p>${setup ? 'Antes de enviar o cadastro, configure um aplicativo autenticador (por exemplo, Google Authenticator, Microsoft Authenticator ou 1Password).' : 'Confirme sua identidade com o código do aplicativo autenticador para enviar o cadastro.'}</p>${setup ? '<div class="kyc-mfa-qr" data-kyc-mfa-qr></div><p>Se não conseguir ler o QR, use esta chave:</p><code class="kyc-mfa-secret" data-kyc-mfa-secret></code>' : ''}<label class="nx-field">Código de 6 dígitos<input name="kyc_mfa_code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required aria-label="Código de autenticação de dois fatores"></label>`;
    const dialog = window.NexoraUI.modal(setup ? 'Ative a verificação em duas etapas' : 'Confirme sua identidade', content, async currentDialog => {
      const code = currentDialog.querySelector('[name="kyc_mfa_code"]').value.trim();
      const { data: challenge, error: challengeError } = await client.auth.mfa.challenge({ factorId: factor.id });
      if (challengeError) throw challengeError;
      const { error: verifyError } = await client.auth.mfa.verify({ factorId: factor.id, challengeId: challenge.id, code });
      if (verifyError) throw verifyError;
      const { data: verifiedAssurance, error: verifiedAssuranceError } = await client.auth.mfa.getAuthenticatorAssuranceLevel();
      if (verifiedAssuranceError) throw verifiedAssuranceError;
      if (verifiedAssurance?.currentLevel !== 'aal2') throw new Error('A verificação não foi concluída. Confira o código e tente novamente.');
      currentDialog.dataset.mfaVerified = 'true';
      return true;
    }, { submitLabel: setup ? 'Ativar e continuar' : 'Confirmar e continuar' });
    if (setup) {
      const qr = document.createElement('img'); qr.src = enrollment.totp.qr_code; qr.alt = 'QR para configurar a verificação em duas etapas';
      dialog.querySelector('[data-kyc-mfa-qr]')?.replaceChildren(qr);
      dialog.querySelector('[data-kyc-mfa-secret]').textContent = enrollment.totp.secret;
    }
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.dataset.mfaVerified === 'true'), { once: true });
    });
  }
  const setNested = (obj, path, value) => { const parts = path.split('.'); let cursor = obj; parts.forEach((part, i) => { if (i === parts.length - 1) cursor[part] = value; else cursor = cursor[part] ||= {}; }); };
  const getNested = (obj, path) => path.split('.').reduce((value, key) => value?.[key], obj);
  const accountType = form.querySelector('[data-account-type]');
  const documentNumber = form.querySelector('[data-document-number]');
  const ownersList = form.querySelector('[data-kyc-owners]');
  const ownerTemplate = form.querySelector('[data-kyc-owner-template]');
  function addOwner(owner = {}) {
    const fragment = ownerTemplate.content.cloneNode(true), row = fragment.querySelector('[data-owner-row]');
    row.dataset.ownerKey = owner.id || crypto.randomUUID();
    row.querySelectorAll('[data-owner-field]').forEach(input => {
      const value = owner[input.dataset.ownerField];
      if (input.type === 'checkbox') input.checked = value === true;
      else if (value != null) input.value = String(value);
    });
    row.querySelector('[data-remove-owner]').addEventListener('click', () => row.remove());
    ownersList.append(fragment);
  }
  function syncAccountType() {
    const individual = accountType.value === 'individual';
    form.querySelector('[data-account-name-label]').firstChild.textContent = individual ? 'Nome completo' : 'Razão social';
    form.querySelector('[data-account-name-label] input').autocomplete = individual ? 'name' : 'organization';
    form.querySelector('[data-document-label]').firstChild.textContent = individual ? 'CPF' : 'CNPJ';
    documentNumber.placeholder = individual ? '000.000.000-00' : '00.ABC.345/01DE-35';
    documentNumber.maxLength = individual ? 14 : 18;
    documentNumber.inputMode = individual ? 'numeric' : 'text';
    form.querySelector('[data-company-representative]').hidden = individual;
    form.querySelector('[data-company-representative] input').required = !individual;
    form.querySelectorAll('[data-company-field]').forEach(section => {
      section.hidden = individual;
      section.querySelectorAll('input,select,textarea').forEach(input => {
        if (input.dataset.requiredForCompany == null) input.dataset.requiredForCompany = input.required ? 'true' : 'false';
        input.required = !individual && input.dataset.requiredForCompany === 'true';
      });
    });
    form.querySelectorAll('[data-company-document]').forEach(label => { label.hidden = individual; });
    form.querySelectorAll('[data-individual-field]').forEach(label => {
      label.hidden = !individual;
      label.querySelectorAll('input').forEach(input => { input.required = individual && input.dataset.requiredForIndividual === 'true'; });
    });
    if (!individual && ownersList && !ownersList.children.length) addOwner();
  }
  accountType.addEventListener('change', syncAccountType);
  form.querySelector('[data-kyc-add-owner]').addEventListener('click', () => {
    if (ownersList.children.length >= 50) return message('O limite é de 50 pessoas relacionadas.');
    addOwner();
  });
  documentNumber.addEventListener('input', () => { documentNumber.value = documentNumber.value.toUpperCase(); });
  syncAccountType();
  function fill(data) {
    if (!data) return;
    if (data.company && !data.company.document_number) {
      let legacyCnpj = '';
      try { legacyCnpj = window.NexoraBrazilianDocuments.normalize(String(data.company.cnpj || '')); } catch (_) {}
      const legacyCpf = String(data.representative?.cpf || '').replace(/\D/g,'');
      data.company.account_type = legacyCnpj ? 'company' : 'individual';
      data.company.document_number = legacyCnpj || legacyCpf;
      data.company.document_type = legacyCnpj ? 'cnpj' : 'cpf';
    }
    form.querySelectorAll('[name]').forEach(input => {
      if (input.type === 'checkbox' || input.type === 'file' || input.readOnly) return;
      const value = getNested(data, input.name); if (value != null) input.value = String(value);
    });
    form.querySelectorAll('input[type=checkbox][name]').forEach(input => { const value = getNested(data, input.name); input.checked = value === true; });
    ownersList.replaceChildren();
    (Array.isArray(data.owners) ? data.owners : []).forEach(owner => addOwner(owner));
    syncAccountType();
  }
  function showUploadedDocs() {
    const old = form.querySelector('[data-existing-docs]'); old?.remove();
    if (!existingDocuments.length) return;
    const box = document.createElement('div'); box.className = 'kyc-doc-links'; box.dataset.existingDocs = '';
    const title = document.createElement('strong'); title.textContent = 'Arquivos já enviados'; box.append(title);
    const labels = {cnpj_proof:'Comprovante CNPJ',company_articles:'Contrato social',representative_id_front:'Documento · frente',representative_id_back:'Documento · verso',company_address_proof:'Endereço da empresa',bank_proof:'Comprovante bancário',power_of_attorney:'Procuração',activity_license:'Licença da atividade',financial_document:'Documento financeiro',additional_document:'Foto com documento',owner_id_front:'Identidade do sócio · frente',owner_id_back:'Identidade do sócio · verso',owner_address_proof:'Endereço do sócio'};
    existingDocuments.forEach(doc => { const item = document.createElement('p'); item.textContent = doc.file_name + ' · ' + (labels[doc.document_type] || doc.document_type) + ' · ' + (doc.subject_key || 'company'); box.append(item); });
    form.querySelector('[data-kyc-docs]')?.append(box);
  }
  async function initialize() {
    try {
      if (!client) throw new Error('Supabase não está configurado.');
      const {data:{session},error} = await client.auth.getSession(); if (error) throw error;
      if (!session) return location.replace('auth.html?mode=login');
      user = session.user;
      form.querySelector('[name="company.email"]').value = user.email || '';
      form.querySelector('[name="company.phone"]').value = user.user_metadata?.phone || user.phone || '';
      const accountName = user.user_metadata?.full_name || '';
      if (accountName) {
        form.querySelector('[name="company.legal_name"]').value = accountName;
        form.querySelector('[name="representative.full_name"]').value = accountName;
      }
      const admin = await window.NexoraAPI.rpc('is_nexora_super_admin_account');
      if (admin) return location.replace('nexora-admin.html');
      const access = await window.NexoraAPI.rpc('get_my_access');
      if (access?.access_status === 'suspended' && access?.onboarding_status === 'SUSPENDED') {
        setStatus('Sua conta está suspensa. Entre em contato com o suporte para receber orientação.','error'); return;
      }
      const {data:application,error:applicationError} = await client.from('merchant_onboarding').select('status,data,reason_description,submitted_at').eq('user_id',user.id).maybeSingle();
      if (applicationError) throw applicationError;
      const state = application?.status || 'DRAFT';
      if (state === 'APPROVED') { setStatus(statusText.APPROVED,'success'); setTimeout(() => location.replace('platform.html'),900); return; }
      if (!ACCEPTING_KYC_SUBMISSIONS && ['DRAFT','REJECTED','PENDING_DOCUMENTS'].includes(state)) {
        setStatus('O cadastro está temporariamente indisponível. Tente novamente em instantes.');
        return;
      }
      const {data:docs,error:docsError} = await client.from('merchant_kyc_documents').select('document_type,subject_key,file_name,storage_path,uploaded_at').eq('user_id',user.id).order('uploaded_at',{ascending:false});
      if (docsError) throw docsError;
      existingDocuments = docs || [];
      const explanation = application?.reason_description ? ' Motivo/orientação: ' + application.reason_description : '';
      setStatus((statusText[state] || statusText.DRAFT) + explanation, state === 'REJECTED' || state === 'PENDING_DOCUMENTS' ? 'warning' : state === 'DRAFT' ? '' : 'success');
      if (['SUBMITTED','UNDER_REVIEW','MANUAL_REVIEW','SUSPENDED','BLOCKED','CLOSED'].includes(state)) {
        const signout = document.querySelector('[data-kyc-logout]'); signout.textContent = 'Sair da conta';
        return;
      }
      fill(application?.data || {});
      if (!form.querySelector('[name="company.phone"]').value.trim()) form.querySelector('[name="company.phone"]').value = user.user_metadata?.phone || user.phone || '';
      showUploadedDocs(); form.hidden = false;
    } catch (error) { setStatus(window.NexoraAPI.errorMessage(error),'error'); }
  }
  document.querySelector('[data-kyc-logout]').onclick = () => window.NexoraUI.confirm('Sair da conta?', 'Você precisará entrar novamente para continuar o cadastro.', window.NexoraUI.logout, 'Sair');
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!form.reportValidity()) return;
    const submit = form.querySelector('[type=submit]'); submit.disabled = true; submit.textContent = 'Enviando com segurança…'; message('');
    try {
      const data = {};
      form.querySelectorAll('[name]').forEach(input => {
        if (input.type === 'file' || input.name === 'consent') return;
        if (input.type === 'checkbox') setNested(data,input.name,input.checked);
        else setNested(data,input.name,input.value.trim());
      });
      const isIndividual = data.company.account_type === 'individual';
      data.company.document_type = isIndividual ? 'cpf' : 'cnpj';
      data.company.document_number = window.NexoraBrazilianDocuments.normalize(String(data.company.document_number || ''));
      // Compatibility with the existing get_my_access() function, which copies company.cnpj
      // into businesses.document. The generic document_number remains the canonical UI field.
      data.company.cnpj = data.company.document_number;
      data.company.trade_name = data.company.legal_name;
      data.representative.full_name = isIndividual ? data.company.legal_name : data.representative.full_name;
      data.representative.cpf = isIndividual ? data.company.document_number : '';
      data.privacy_consent = true;
      if (!window.NexoraBrazilianDocuments.isValid(data.company.document_number, isIndividual ? 'cpf' : 'cnpj')) {
        throw new Error(isIndividual ? 'Confira o CPF informado.' : 'Confira o CNPJ. Ele pode ser numérico ou alfanumérico, com 14 posições e dígitos verificadores válidos.');
      }
      if (!/^\S+@\S+\.\S+$/.test(data.company.email || '')) throw new Error('Entre novamente para atualizar o e-mail da conta.');
      const ownerRows = [...ownersList.querySelectorAll('[data-owner-row]')];
      data.owners = isIndividual ? [{
        id: crypto.randomUUID(), full_name: data.representative.full_name, cpf: data.company.document_number,
        birth_date: data.representative.birth_date, nationality: data.representative.nationality,
        phone: data.company.phone, email: data.company.email, role: 'Titular', equity_percentage: 100,
        address: [data.company.address_street, data.company.address_extra, data.company.address_neighborhood,
          data.company.address_city, data.company.address_state, data.company.postal_code].filter(Boolean).join(', '),
        legal_representative: true, beneficial_owner: true, pep_declared: data.representative.pep_declared === true
      }] : ownerRows.map(row => {
        const owner = { id: row.dataset.ownerKey };
        row.querySelectorAll('[data-owner-field]').forEach(input => {
          owner[input.dataset.ownerField] = input.type === 'checkbox' ? input.checked : input.value.trim();
        });
        return owner;
      });
      const files = [
        ...[...form.querySelectorAll('[data-kyc-document]')].map(input => ({input, docType:input.dataset.kycDocument, subjectKey:input.dataset.documentSubject || 'company'})),
        ...ownerRows.flatMap(row => [...row.querySelectorAll('[data-owner-document]')].map(input => ({input, docType:input.dataset.ownerDocument, subjectKey:'owner:' + row.dataset.ownerKey})))
      ].filter(({input}) => input.files?.[0]);
      data.privacy_consent = true;
      data.privacy_notice_version = '2026-10-12-kyb-v1';
      // Process optional document uploads if any were provided
      for (const {input,docType,subjectKey} of files) {
        const file = input.files?.[0];
        if (!file) continue;
        if (!['image/jpeg','image/png','image/webp','application/pdf'].includes(file.type) || file.size > 10 * 1024 * 1024) continue;
        const prior = existingDocuments.find(doc => doc.document_type === docType && doc.subject_key === subjectKey && doc.storage_path);
        const ext = ({'image/jpeg':'jpg','image/png':'png','image/webp':'webp','application/pdf':'pdf'})[file.type] || 'pdf';
        const path = user.id + '/' + docType + '/' + crypto.randomUUID() + '.' + ext;
        try {
          const {error:uploadError} = await client.storage.from('nexora-kyc').upload(path,file,{contentType:file.type,upsert:false});
          if (!uploadError) {
            await client.rpc('nexora_kyc_register_document_v2',{p_document_type:docType,p_subject_key:subjectKey,p_storage_path:path,p_file_name:file.name,p_content_type:file.type,p_size_bytes:file.size});
            if (prior) await client.storage.from('nexora-kyc').remove([prior.storage_path]);
            existingDocuments = existingDocuments.filter(doc => doc.document_type !== docType);
            existingDocuments.push({document_type:docType,subject_key:subjectKey,file_name:file.name,storage_path:path});
          }
        } catch (_) {}
      }
      const {data:submitRes,error:submitError} = await client.rpc('nexora_kyc_submit',{p_data:data});
      if (submitError) throw submitError;
      form.hidden = true;
      if (submitRes?.status === 'APPROVED') {
        setStatus('Conta aprovada com sucesso! Abrindo sua operação…','success');
        setTimeout(() => location.replace('platform.html'), 900);
      } else {
        setStatus('Cadastro enviado com sucesso! Seus dados estão em análise pela equipe da Nexora. Redirecionando…','info');
        setTimeout(() => location.replace('platform.html'), 1500);
      }
    } catch (error) { message(window.NexoraAPI.errorMessage(error)); }
    finally { submit.disabled = false; submit.innerHTML = 'Enviar cadastro <span aria-hidden="true">→</span>'; }
  });
  initialize();
})();
