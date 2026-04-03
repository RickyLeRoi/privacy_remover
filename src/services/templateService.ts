import { Address, Broker, DiscoveryKey, LegalBasis, Person } from "@prisma/client";
import { gdprErasureTemplate } from "../templates/gdprErasure";
import { ccpaOptOutTemplate } from "../templates/ccpaOptOut";
import { genericOptOutTemplate } from "../templates/genericOptOut";

type PersonWithAddresses = Person & { addresses: Address[] };

export function generateMessage(
  person: PersonWithAddresses,
  broker: Broker
): { subject: string; body: string; discoveryKeysUsed: DiscoveryKey[] } {
  // Decide which discovery keys to include based on what the broker accepts
  const keysUsed: DiscoveryKey[] = [];
  const identityLines: string[] = [];

  if (
    broker.acceptedDiscoveryKeys.includes("email") &&
    person.emails.length > 0
  ) {
    keysUsed.push("email");
    identityLines.push(`Email: ${person.emails.join(", ")}`);
  }
  if (
    broker.acceptedDiscoveryKeys.includes("phone") &&
    person.phones.length > 0
  ) {
    keysUsed.push("phone");
    identityLines.push(`Phone: ${person.phones.join(", ")}`);
  }
  if (
    broker.acceptedDiscoveryKeys.includes("address") &&
    person.addresses.length > 0
  ) {
    keysUsed.push("address");
    const addr = person.addresses.map(
      (a) => `${a.street}, ${a.city}${a.region ? " (" + a.region + ")" : ""}, ${a.country}`
    );
    identityLines.push(`Address(es): ${addr.join(" | ")}`);
  }

  // fullName is intentionally NOT included here.
  // If broker.requiresFullName, the operator must add it manually in the
  // response phase via /api/persons/:id/response-identity.

  const identityBlock = identityLines.join("\n");

  const { subject, body } =
    broker.legalBasis === LegalBasis.gdpr
      ? gdprErasureTemplate(broker.name, identityBlock)
      : broker.legalBasis === LegalBasis.ccpa
      ? ccpaOptOutTemplate(broker.name, identityBlock)
      : genericOptOutTemplate(broker.name, identityBlock);

  return { subject, body, discoveryKeysUsed: keysUsed };
}
