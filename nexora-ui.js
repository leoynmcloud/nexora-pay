(function () {
  'use strict';
  const escape = window.NexoraCore.escape;
  let serial = 0;
  function toast(message) {
    document.querySelector('.nexora-toast')?.remove();
    const node = document.createElement('div');
    node.className = 'nexora-toast show'; node.setAttribute('role', 'status'); node.textContent = message;
    document.body.append(node); setTimeout(() => node.remove(), 5000);
  }
  function modal(title, content, submit, options = {}) {
    const previous = document.activeElement;
    const id = `nexora-dialog-${++serial}`;
    const dialog = document.createElement('dialog'); dialog.className = 'nx-dialog' + (options.className ? ' ' + options.className : '');
    dialog.setAttribute('aria-labelledby', id);
    dialog.innerHTML = `<form><header><h2 id="${id}">${escape(title)}</h2><button type="button" class="nx-close" aria-label="Fechar">×</button></header><div class="nx-dialog-body">${content}</div><p class="nx-form-error" role="alert"></p><footer><button type="button" class="button outline nx-cancel">${submit ? 'Cancelar' : 'Fechar'}</button>${submit ? `<button type="submit" class="button button-primary">${escape(options.submitLabel || 'Salvar')}</button>` : ''}</footer></form>`;
    document.body.append(dialog);
    let busy = false;
    const close = () => {
      if (busy) return;
      if (typeof dialog.close === 'function') dialog.close();
      else { dialog.removeAttribute('open'); dialog.dispatchEvent(new Event('close')); }
    };
    dialog.querySelector('.nx-close').onclick = close;
    dialog.querySelector('.nx-cancel').onclick = close;
    dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close(); }
    });
    dialog.addEventListener('close', () => { dialog.remove(); if (previous?.isConnected) previous.focus(); }, { once: true });
    dialog.querySelector('form').addEventListener('submit', async (event) => {
      event.preventDefault(); if (busy || !submit || !event.target.reportValidity()) return;
      busy = true; const buttons = [...dialog.querySelectorAll('button')]; buttons.forEach((button) => { button.disabled = true; });
      const button = dialog.querySelector('[type=submit]'); const label = button.textContent; button.textContent = 'Salvando…';
      dialog.querySelector('.nx-form-error').textContent = '';
      try { const result = await submit(dialog); if (result !== false) { busy = false; dialog.close(); } }
      catch (error) { dialog.querySelector('.nx-form-error').textContent = error.message || 'Não foi possível salvar. Tente novamente.'; }
      finally { busy = false; if (dialog.isConnected) { buttons.forEach((item) => { item.disabled = false; }); button.textContent = label; } }
    });
    dialog.querySelectorAll('[data-currency]').forEach((input) => input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '');
      if (input.value.includes('-') || digits.length > 12) { input.setCustomValidity('Informe um valor positivo de até R$ 9.999.999.999,99.'); return; }
      input.setCustomValidity('');
      input.value = digits ? (Number(digits) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
    }));
    try {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } catch (_) { dialog.setAttribute('open', ''); }
    return dialog;
  }
  const confirm = (title, description, action, label = 'Confirmar') => modal(title, `<p>${escape(description)}</p>`, action, { submitLabel: label });
  async function logout() {
    const { error } = await window.nexoraSupabase.auth.signOut();
    if (error) throw new Error('Não foi possível sair. Tente novamente.');
    window.location.assign('auth.html');
  }
  window.NexoraUI = { toast, modal, confirm, logout };
})();
