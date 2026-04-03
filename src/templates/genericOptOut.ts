export function genericOptOutTemplate(
  brokerName: string,
  identityBlock: string
): { subject: string; body: string } {
  const subject = `Data Removal / Opt-Out Request — ${brokerName}`;
  const body = `To the Privacy Team at ${brokerName},

I am writing to request the removal of all personal data associated with the following identifiers from your platform and any affiliated databases:

${identityBlock}

Please confirm the removal within 30 days.

Thank you.`;
  return { subject, body };
}
