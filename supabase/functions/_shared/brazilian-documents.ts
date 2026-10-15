function stripDocumentFormatting(value: string) {
  return value.trim().toUpperCase().replace(/[.\-/\s]/g, '');
}

export function normalizeBrazilianDocument(value: unknown) {
  if (typeof value !== 'string' || value.length > 32) throw new Error('brazilian_document_invalid');
  const normalized = stripDocumentFormatting(value);
  if (!/^[A-Z0-9]+$/.test(normalized) || ![11, 14].includes(normalized.length)) {
    throw new Error('brazilian_document_invalid');
  }
  return normalized;
}

export function isValidCpf(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digit = (length: number) => {
    const sum = [...value.slice(0, length)].reduce((total, char, index) => total + Number(char) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
}

/** RFB/SERPRO CNPJ DV: use ASCII - 48 for positions 1–12, then mod 11. */
export function isValidCnpj(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z0-9]{12}\d{2}$/.test(value) || /^(.)\1{13}$/.test(value)) return false;
  const checkDigit = (base: string) => {
    const weights = base.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = [...base].reduce((total, char, index) => total + (char.charCodeAt(0) - 48) * weights[index], 0);
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return checkDigit(value.slice(0, 12)) === Number(value[12])
    && checkDigit(value.slice(0, 13)) === Number(value[13]);
}

export function isValidBrazilianDocument(value: unknown, type?: 'cpf' | 'cnpj') {
  let normalized: string;
  try { normalized = normalizeBrazilianDocument(value); } catch { return false; }
  if (type === 'cpf') return isValidCpf(normalized);
  if (type === 'cnpj') return isValidCnpj(normalized);
  return normalized.length === 11 ? isValidCpf(normalized) : isValidCnpj(normalized);
}
