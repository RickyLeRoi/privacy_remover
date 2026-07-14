export function gdprAccessTemplate(
  brokerName: string,
  identityBlock: string
): { subject: string; body: string } {
  const subject = `Right of Access Request — GDPR Article 15 — ${brokerName}`;
  const body = `To the Data Protection Officer / Privacy Team at ${brokerName},

I am an individual exercising my right of access under Article 15 of the General Data Protection Regulation (EU) 2016/679 (GDPR).

Please confirm whether or not you process personal data concerning me. If you do, please provide:

1. The categories of personal data you hold about me.
2. The purposes of the processing and the legal basis relied upon.
3. The recipients or categories of recipients to whom the data has been or will be disclosed.
4. The source from which the data was obtained, if not collected directly from me.
5. The envisaged retention period.
6. A copy of the personal data undergoing processing.

The identifiers you may use to locate any records concerning me:

${identityBlock}

If you do NOT hold any personal data concerning me, please state so explicitly: I will consider the matter closed.

Please respond within one month, as required by Article 12(3) GDPR. Should you fail to respond within the statutory period, I reserve the right to lodge a complaint with the competent supervisory authority.

Yours faithfully,
[Data Subject]`;
  return { subject, body };
}
