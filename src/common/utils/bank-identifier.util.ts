import { BANK_CITAD_CATALOG, KNOWN_BANK_BINS } from './bank-citad-catalog';

const knownBins = new Set(KNOWN_BANK_BINS);

// Only exact codes present in the reviewed snapshot are accepted.
const aliases: Record<string, string> = Object.create(null);
for (const bank of BANK_CITAD_CATALOG) {
  for (const citad of bank.citadCodes) {
    if (aliases[citad] && aliases[citad] !== bank.bin) {
      throw new Error('Conflicting bank identifier catalogue');
    }
    aliases[citad] = bank.bin;
  }
}
const CITAD_TO_BIN: Readonly<Record<string, string>> = Object.freeze(aliases);

export function normalizeBankBin(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const value = code.trim();
  if (/^[0-9]{6}$/.test(value) && knownBins.has(value)) return value;
  return Object.prototype.hasOwnProperty.call(CITAD_TO_BIN, value)
    ? CITAD_TO_BIN[value]
    : null;
}

/** For immutable receipt comparison, preserve unknown raw identifiers. */
export function bankEvidenceKey(code: string | null | undefined): string | null {
  return normalizeBankBin(code) || code?.trim() || null;
}

export function bankBinsMatch(left: string | null | undefined, right: string | null | undefined): boolean {
  const bin = normalizeBankBin(left);
  return bin !== null && bin === normalizeBankBin(right);
}
