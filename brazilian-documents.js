(function (root) {
  'use strict';
  function normalize(value) {
    if (typeof value !== 'string' || value.length > 32) throw new Error('Documento inválido.');
    const normalized = value.trim().toUpperCase().replace(/[.\-/\s]/g, '');
    if (!/^[A-Z0-9]+$/.test(normalized) || ![11, 14].includes(normalized.length)) throw new Error('Documento inválido.');
    return normalized;
  }
  function validCpf(value) {
    if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
    const digit = length => {
      const sum = [...value.slice(0, length)].reduce((total, char, index) => total + Number(char) * (length + 1 - index), 0);
      const remainder = (sum * 10) % 11;
      return remainder === 10 ? 0 : remainder;
    };
    return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
  }
  function validCnpj(value) {
    if (!/^[A-Z0-9]{12}\d{2}$/.test(value) || /^(.)\1{13}$/.test(value)) return false;
    const digit = base => {
      const weights = base.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const sum = [...base].reduce((total, char, index) => total + (char.charCodeAt(0) - 48) * weights[index], 0);
      const remainder = sum % 11;
      return remainder < 2 ? 0 : 11 - remainder;
    };
    return digit(value.slice(0, 12)) === Number(value[12]) && digit(value.slice(0, 13)) === Number(value[13]);
  }
  function isValid(value, type) {
    let normalized;
    try { normalized = normalize(value); } catch (_) { return false; }
    if (type === 'cpf') return validCpf(normalized);
    if (type === 'cnpj') return validCnpj(normalized);
    return normalized.length === 11 ? validCpf(normalized) : validCnpj(normalized);
  }
  root.NexoraBrazilianDocuments = Object.freeze({ normalize, isValid });
})(typeof window === 'undefined' ? globalThis : window);
