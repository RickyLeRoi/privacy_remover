export function gdprErasureTemplate(
  brokerName: string,
  identityBlock: string
): { subject: string; body: string } {
  const subject = `Right to Erasure Request — GDPR Article 17 — ${brokerName}`;
  const body = `To the Data Protection Officer / Privacy Team at ${brokerName},

I am an individual exercising my right to erasure under Article 17 of the General Data Protection Regulation (EU) 2016/679 (GDPR).

I request that you immediately and permanently delete all personal data you hold about me from all your systems, databases, and records, and that you notify any third parties to whom you have disclosed my data.

My identifying information is as follows:

${identityBlock}

Please:
1. Confirm receipt of this request within 72 hours.
2. Complete the erasure and send written confirmation within 30 calendar days, as required by GDPR Article 12(3).
3. Provide details of any third parties that have received my data.

If you require clarification, you may reach me at the email address listed above.

Should you fail to respond or comply within the statutory period, I reserve the right to lodge a complaint with the competent supervisory authority.

Yours faithfully,
[Data Subject]`;
  return { subject, body };
}
