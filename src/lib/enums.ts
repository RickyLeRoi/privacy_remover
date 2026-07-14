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
  SENT: "SENT",
  AWAITING_RESPONSE: "AWAITING_RESPONSE",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED",
  NEEDS_RECHECK: "NEEDS_RECHECK",
  CLOSED: "CLOSED",
} as const;
export type CaseStatus = (typeof CaseStatus)[keyof typeof CaseStatus];

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
