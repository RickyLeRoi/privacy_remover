// 20260701 RG - Sostituiscono gli enum Prisma: SQLite non li supporta, le colonne
// sono String. I valori devono restare allineati a quelli scritti a DB.

export const LegalBasis = {
  gdpr: "gdpr",
  ccpa: "ccpa",
  opt_out: "opt_out",
} as const;
export type LegalBasis = (typeof LegalBasis)[keyof typeof LegalBasis];

export const ContactMethod = {
  email: "email",
  form: "form",
  api: "api",
} as const;
export type ContactMethod = (typeof ContactMethod)[keyof typeof ContactMethod];

export const CaseStatus = {
  NOT_STARTED: "NOT_STARTED",
  // 20260701 RG - QUEUED: in attesa che il worker la spedisca. Lo stato sta a DB e
  // non in memoria, così una coda di centinaia di invii sopravvive al riavvio.
  QUEUED: "QUEUED",
  SENT: "SENT",
  // Richiesta di accesso (GDPR Art.15) inviata: si aspetta di sapere SE hanno dati.
  ACCESS_SENT: "ACCESS_SENT",
  // Il broker ha risposto che non tratta dati di questa persona: nulla da cancellare.
  NO_DATA: "NO_DATA",
  AWAITING_RESPONSE: "AWAITING_RESPONSE",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  NEEDS_RECHECK: "NEEDS_RECHECK",
  CLOSED: "CLOSED",
} as const;
export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];

export const BrokerCategory = {
  people_search: "people_search",
  credit: "credit",
  registry: "registry",
  adtech: "adtech",
  marketing: "marketing",
  other: "other",
} as const;
export type BrokerCategory = (typeof BrokerCategory)[keyof typeof BrokerCategory];

export const PresenceResult = {
  found: "found",
  not_found: "not_found",
  unknown: "unknown",
} as const;
export type PresenceResult = (typeof PresenceResult)[keyof typeof PresenceResult];

export const Channel = {
  email: "email",
  form_manual: "form_manual",
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

export const EvidenceType = {
  sent_email: "sent_email",
  broker_response: "broker_response",
  screenshot: "screenshot",
  id_doc: "id_doc",
} as const;
export type EvidenceType = (typeof EvidenceType)[keyof typeof EvidenceType];

export const VerificationResult = {
  removed: "removed",
  still_present: "still_present",
  error: "error",
} as const;
export type VerificationResult = (typeof VerificationResult)[keyof typeof VerificationResult];

export const DiscoveryKey = {
  email: "email",
  phone: "phone",
  address: "address",
} as const;
export type DiscoveryKey = (typeof DiscoveryKey)[keyof typeof DiscoveryKey];
