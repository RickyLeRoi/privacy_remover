import { prisma } from "./prisma";

export const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash";

// 20260701 RG - Cache in memoria: authMiddleware gira su ogni richiesta e senza
// questa farebbe una query per ognuna. Va invalidata a ogni scrittura.
const cache = new Map<string, string>();

export async function getSetting(key: string): Promise<string | null> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;

  cache.set(key, row.value);
  return row.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  cache.set(key, value);
}

export async function deleteSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
  cache.delete(key);
}
