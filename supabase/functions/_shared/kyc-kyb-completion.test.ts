import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);
const migration = readFileSync(new URL('nexora-kyc-kyb-completion.sql', root), 'utf8');
const onboarding = readFileSync(new URL('onboarding.html', root), 'utf8');
const onboardingJs = readFileSync(new URL('onboarding.js', root), 'utf8');
const adminJs = readFileSync(new URL('nexora-admin.js', root), 'utf8');
const privacy = readFileSync(new URL('privacidade.html', root), 'utf8');

describe('KYC/KYB completion contract', () => {
  it('collects the business profile and linked natural persons required for KYB', () => {
    for (const field of ['primary_cnae','opened_at','activity_description','expected_tpv_monthly','payment_mix.pix','payment_mix.card','payment_mix.boleto','source_of_funds','settlement.bank_name']) {
      assert.ok(onboarding.includes(`name="company.${field}"`) || onboarding.includes(`name="${field}"`), `missing ${field}`);
    }
    for (const field of ['full_name','cpf','birth_date','nationality','equity_percentage','beneficial_owner','pep_declared']) {
      assert.ok(onboarding.includes(`data-owner-field="${field}"`), `missing owner ${field}`);
    }
    assert.match(onboardingJs, /data\.owners = isIndividual \?/);
    assert.match(onboardingJs, /owner_id_front/);
  });

  it('keeps document uploads private, scoped to a subject, MFA-gated and server validated', () => {
    assert.match(migration, /enable row level security/i);
    assert.match(migration, /revoke all on public\.merchant_kyc_screenings from public,anon,authenticated/i);
    assert.match(migration, /nexora_kyc_register_document_v2/);
    assert.match(migration, /auth\.jwt\(\)->>'aal'.*aal2/s);
    assert.match(migration, /Confirme MFA para consultar cadastros e documentos/);
    assert.match(migration, /Confirme MFA antes de decidir o cadastro/);
    assert.match(migration, /on conflict\(user_id,document_type,subject_key\)/);
    assert.match(onboardingJs, /nexora_kyc_register_document_v2/);
  });

  it('records manual screening as append-only evidence and requires a clear current batch before approval', () => {
    assert.match(migration, /create table if not exists public\.merchant_kyc_screenings/i);
    assert.match(migration, /before update on public\.merchant_kyc_screenings/i);
    assert.match(migration, /current_screening_batch_id=null/i);
    assert.match(migration, /current_screening_batch_id=v_batch/i);
    assert.match(migration, /not é possível aprovar|Não é possível aprovar.*diligência PEP\/sanções/is);
    assert.match(adminJs, /nexora_admin_record_kyc_screening/);
    assert.match(adminJs, /não consulta listas externas automaticamente/i);
  });

  it('updates the privacy notice to disclose additional business and related-person data', () => {
    assert.match(privacy, /quadro societário|sócios, administradores e beneficiários finais/i);
    assert.match(privacy, /PEP e listas restritivas/i);
    assert.match(privacy, /revisão jurídica/i);
    assert.match(onboardingJs, /2026-10-12-kyb-v1/);
  });
});
