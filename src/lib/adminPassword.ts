import bcrypt from "bcryptjs";
import { ADMIN_PASSWORD_HASH_KEY, deleteSetting, getSetting, setSetting } from "./settings";

export const MIN_PASSWORD_LENGTH = 8;

// 20260701 RG - ADMIN_PASSWORD_HASH (env) ha la precedenza sul valore nel DB ed è
// una via di recupero: se la password viene dimenticata, si riavvia il container
// con l'env valorizzata e si rientra. Se è impostata, l'app non è mai "da configurare".
function envHash(): string | null {
  const h = process.env.ADMIN_PASSWORD_HASH?.trim();
  return h ? h : null;
}

export async function getHash(): Promise<string | null> {
  return envHash() ?? (await getSetting(ADMIN_PASSWORD_HASH_KEY));
}

export async function isConfigured(): Promise<boolean> {
  return (await getHash()) !== null;
}

export async function setPassword(plain: string): Promise<void> {
  await setSetting(ADMIN_PASSWORD_HASH_KEY, bcrypt.hashSync(plain, 12));
}

export async function verifyPassword(plain: string): Promise<boolean> {
  const hash = await getHash();
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export async function clearPassword(): Promise<void> {
  await deleteSetting(ADMIN_PASSWORD_HASH_KEY);
}
