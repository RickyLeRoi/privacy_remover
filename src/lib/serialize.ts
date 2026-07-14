// 20260701 RG - SQLite non ha array: le liste sono salvate come stringhe JSON.
// Le route devono impacchettare in scrittura e spacchettare in risposta, così
// l'API continua a esporre array veri.

export function packList(xs: readonly string[] | null | undefined): string {
  return JSON.stringify(xs ?? []);
}

export function unpackList(s: string | null | undefined): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function personOut<T extends { emails: string; phones: string; aliases: string }>(
  p: T
): Omit<T, "emails" | "phones" | "aliases"> & { emails: string[]; phones: string[]; aliases: string[] } {
  return {
    ...p,
    emails: unpackList(p.emails),
    phones: unpackList(p.phones),
    aliases: unpackList(p.aliases),
  };
}

export function brokerOut<T extends { acceptedDiscoveryKeys: string }>(
  b: T
): Omit<T, "acceptedDiscoveryKeys"> & { acceptedDiscoveryKeys: string[] } {
  return { ...b, acceptedDiscoveryKeys: unpackList(b.acceptedDiscoveryKeys) };
}
