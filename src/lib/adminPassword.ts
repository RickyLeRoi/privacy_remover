import bcrypt from "bcryptjs";
import crypto from "crypto";
import { ADMIN_PASSWORD_HASH_KEY, deleteSetting, getSetting, setSetting } from "./settings";

export const MIN_PASSWORD_LENGTH = 8;

// 20260701 RG - authMiddleware gira su OGNI richiesta e bcryptjs è JS puro: a costo
// 12 una compare impiega ~400ms e blocca l'event loop, quindi le chiamate si
// serializzano (il caricamento della dashboard, 5 richieste, arrivava a >2s).
// Qui si memorizza il token già verificato, associato all'hash contro cui è stato
// validato: se la password cambia, l'hash cambia e le voci vecchie non combaciano
// più, quindi la cache si invalida da sola. Solo i token CORRETTI entrano in cache,
// così un attacco a forza bruta non la può gonfiare.
const verifiedTokens = new Map<string, string>();

function digest(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

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
  verifiedTokens.clear();
}

export async function verifyPassword(plain: string): Promise<boolean> {
  const hash = await getHash();
  if (!hash) return false;

  const d = digest(plain);
  if (verifiedTokens.get(d) === hash) return true;

  const ok = await bcrypt.compare(plain, hash);
  if (ok) verifiedTokens.set(d, hash);
  return ok;
}

export async function clearPassword(): Promise<void> {
  await deleteSetting(ADMIN_PASSWORD_HASH_KEY);
  verifiedTokens.clear();
}
