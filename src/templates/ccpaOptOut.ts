export function ccpaOptOutTemplate(
  brokerName: string,
  identityBlock: string
): { subject: string; body: string } {
  const subject = `CCPA Opt-Out & Deletion Request — ${brokerName}`;
  const body = `To the Privacy Team at ${brokerName},

Pursuant to the California Consumer Privacy Act (CCPA) as amended by the CPRA, I am submitting a request to:

1. Opt out of the sale and sharing of my personal information.
2. Delete all personal information you hold about me.

My identifying information:

${identityBlock}

Please confirm receipt within 10 business days and complete deletion within 45 calendar days.

Regards,
[Data Subject]`;
  return { subject, body };
}
