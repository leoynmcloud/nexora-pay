import { isValidCnpj, normalizeBrazilianDocument } from './brazilian-documents.ts';

export type PixDestinationKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'PHONE' | 'EVP';
export type NormalizedPixDestination = { pixAddressKey: string; pixAddressKeyType: PixDestinationKeyType };

function validCpf(value: string): boolean {
  if (!/^\d{11}$/.test(value) || /^([0-9])\1{10}$/.test(value)) return false;
  const digit = (length: number) => {
    const sum = [...value.slice(0, length)].reduce((total, char, index) => total + Number(char) * (length + 1 - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
}

/** Normalize common Pix key forms without depending on any specific acquirer. */
export function normalizePixDestination(destination: NormalizedPixDestination): NormalizedPixDestination {
  if (!destination || !['CPF', 'CNPJ', 'EMAIL', 'PHONE', 'EVP'].includes(destination.pixAddressKeyType)
    || typeof destination.pixAddressKey !== 'string' || !destination.pixAddressKey.trim()
    || destination.pixAddressKey.length > 200) throw new Error('pix_destination_invalid');
  const key = destination.pixAddressKey.trim();
  switch (destination.pixAddressKeyType) {
    case 'CPF': {
      const digits = key.replace(/[.\-/\s]/g, '');
      if (!validCpf(digits)) throw new Error('pix_destination_invalid');
      return { pixAddressKey: digits, pixAddressKeyType: 'CPF' };
    }
    case 'CNPJ': {
      let cnpj = '';
      try { cnpj = normalizeBrazilianDocument(key); } catch { throw new Error('pix_destination_invalid'); }
      if (!isValidCnpj(cnpj)) throw new Error('pix_destination_invalid');
      return { pixAddressKey: cnpj, pixAddressKeyType: 'CNPJ' };
    }
    case 'PHONE': {
      let digits = key.replace(/[()\s.-]/g, '');
      if (digits.startsWith('+55')) digits = digits.slice(3);
      else if (digits.startsWith('55') && digits.length === 13) digits = digits.slice(2);
      if (!/^\d{11}$/.test(digits)) throw new Error('pix_destination_invalid');
      return { pixAddressKey: digits, pixAddressKeyType: 'PHONE' };
    }
    case 'EMAIL': {
      const email = key.toLowerCase();
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('pix_destination_invalid');
      return { pixAddressKey: email, pixAddressKeyType: 'EMAIL' };
    }
    case 'EVP':
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
        throw new Error('pix_destination_invalid');
      }
      return { pixAddressKey: key.toLowerCase(), pixAddressKeyType: 'EVP' };
  }
}
