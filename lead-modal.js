/**
 * Nexora Pay — Lead & Presentation Modal
 * High-converting presentation request modal with WhatsApp direct-connect and form capture.
 */
(function () {
  'use strict';

  function initLeadModal() {
    const triggers = document.querySelectorAll('[data-open-lead-modal]');
    const modal = document.getElementById('lead-modal');
    if (!modal) return;

    const closeBtn = modal.querySelector('[data-close-lead-modal]');
    const form = modal.querySelector('#lead-form');
    const successBox = modal.querySelector('[data-lead-success]');

    function openModal() {
      if (typeof modal.showModal === 'function') {
        modal.showModal();
      } else {
        modal.setAttribute('open', 'true');
      }
      document.body.style.overflow = 'hidden';
      // Track conversion/lead intent
      window.dispatchEvent(new CustomEvent('nexora-lead-opened'));
    }

    function closeModal() {
      if (typeof modal.close === 'function') {
        modal.close();
      } else {
        modal.removeAttribute('open');
      }
      document.body.style.overflow = '';
      if (form) form.reset();
      if (successBox) successBox.style.display = 'none';
      if (form) form.style.display = 'block';
    }

    triggers.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openModal();
      });
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', closeModal);
    }

    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    // Form submission
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = form.querySelector('[type="submit"]');
        const originalText = submitBtn ? submitBtn.textContent : 'Enviar';
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Enviando...';
        }

        const formData = new FormData(form);
        const name = formData.get('name') || '';
        const email = formData.get('email') || '';
        const phone = formData.get('phone') || '';
        const volume = formData.get('volume') || 'Não informado';

        // Log / Track conversion
        try {
          if (window.nexoraSupabase) {
            // Optional DB storage if leads table exists, or audit log
            console.log('Lead recebido:', { name, email, phone, volume });
          }
        } catch (_) {}

        // WhatsApp direct redirect or success card
        const isWhatsAppDirect = e.submitter && e.submitter.dataset.action === 'whatsapp';
        if (isWhatsAppDirect) {
          const msg = encodeURIComponent(`Olá, time comercial Nexora Pay! Meu nome é ${name}. Tenho interesse em uma apresentação para meu negócio (Volume mensal: ${volume}). E-mail: ${email}`);
          window.open(`https://wa.me/5511999999999?text=${msg}`, '_blank');
        }

        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = originalText;
        }

        // Show success state
        if (form && successBox) {
          form.style.display = 'none';
          successBox.style.display = 'block';
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLeadModal);
  } else {
    initLeadModal();
  }
})();
