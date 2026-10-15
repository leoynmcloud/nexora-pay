(function () {
  'use strict';
  const key = 'nexora-cookie-consent-v1', UI = window.NexoraUI;
  let preference;
  try { preference = JSON.parse(localStorage.getItem(key) || 'null'); if (preference?.version !== 1 || !Number.isFinite(preference.timestamp) || Date.now() - preference.timestamp > 180 * 86400000) preference = null; } catch { preference = null; }
  function save(functional) {
    preference = { version: 1, timestamp: Date.now(), necessary: true, functional: !!functional, analytics: false, marketing: false };
    try { localStorage.setItem(key, JSON.stringify(preference)); } catch { UI.toast('Sua escolha vale nesta visita; armazenamento indisponível.'); }
    document.querySelector('.cookie-banner')?.remove(); window.dispatchEvent(new CustomEvent('nexora-consent-change', { detail: { ...preference } }));
  }
  function customize() {
    UI.modal('Preferências de cookies', '<p>Usamos armazenamento necessário para sessão, segurança e sua escolha de consentimento. Não há rastreadores de publicidade ou análise ativados.</p><label class="nx-check"><input type="checkbox" checked disabled> Necessários (sempre ativos)</label><label class="nx-check"><input type="checkbox" name="functional" '+(preference?.functional ? 'checked' : '')+'> Lembrar preferência de tema entre visitas</label><p>Analytics e marketing: não utilizados no momento. Nenhum serviço desse tipo é carregado ao aceitar.</p><a class="nx-link" href="privacidade.html#cookies">Ler política de cookies</a>', async (dialog) => { save(dialog.querySelector('[name=functional]').checked); }, { submitLabel: 'Salvar preferências' });
  }
  if (!preference) {
    const banner = document.createElement('section'); banner.className = 'cookie-banner'; banner.setAttribute('aria-label','Preferências de privacidade');
    banner.innerHTML = '<div><strong>Sua privacidade importa.</strong><p>Usamos armazenamento necessário para o site e sua sessão. Recursos opcionais ficam desativados até sua escolha. <a href="privacidade.html#cookies">Saiba mais</a>.</p></div><div class="cookie-actions"><button class="button outline" data-cookie="necessary">Somente necessários</button><button class="button outline" data-cookie="customize">Personalizar</button><button class="button outline" data-cookie="accept">Aceitar opcionais</button></div>';
    document.body.append(banner);
    banner.querySelector('[data-cookie=necessary]').onclick = () => save(false); banner.querySelector('[data-cookie=accept]').onclick = () => save(true); banner.querySelector('[data-cookie=customize]').onclick = customize;
  }
  document.querySelectorAll('[data-cookie-settings]').forEach((button) => button.onclick = customize);
  window.NexoraConsent = { get: () => preference ? { ...preference } : { necessary: true, functional: false, analytics: false, marketing: false }, customize };
})();
