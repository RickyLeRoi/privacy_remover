import { Address, Broker, Person } from "@prisma/client";
import { DiscoveryKey, LegalBasis } from "../lib/enums";
import { unpackList } from "../lib/serialize";
import { gdprErasureTemplate } from "../templates/gdprErasure";
import { ccpaOptOutTemplate } from "../templates/ccpaOptOut";
import { genericOptOutTemplate } from "../templates/genericOptOut";

type PersonWithAddresses = Person & { addresses: Address[] };

export function generateMessage(
  person: PersonWithAddresses,
  broker: Broker
): { subject: string; body: string; discoveryKeysUsed: DiscoveryKey[] } {
  const acceptedKeys = unpackList(broker.acceptedDiscoveryKeys);
  const emails = unpackList(person.emails);
  const phones = unpackList(person.phones);

  const keysUsed: DiscoveryKey[] = [];
  const identityLines: string[] = [];

  if (acceptedKeys.includes("email") && emails.length > 0) {
    keysUsed.push("email");
    identityLines.push(`Email: ${emails.join(", ")}`);
  }
  if (acceptedKeys.includes("phone") && phones.length > 0) {
    keysUsed.push("phone");
    identityLines.push(`Phone: ${phones.join(", ")}`);
  }
  if (acceptedKeys.includes("address") && person.addresses.length > 0) {
    keysUsed.push("address");
    const addr = person.addresses.map(
      (a) => `${a.street}, ${a.city}${a.region ? " (" + a.region + ")" : ""}, ${a.country}`
    );
    identityLines.push(`Address(es): ${addr.join(" | ")}`);
  }

  // 20260701 RG - fullName non deve mai finire nella richiesta iniziale, neanche
  // se broker.requiresFullName è true: in quel caso va aggiunto a mano in fase di
  // risposta, leggendolo da /api/persons/:id/response-identity.

  const identityBlock = identityLines.join("\n");

  const { subject, body } =
    broker.legalBasis === LegalBasis.gdpr
      ? gdprErasureTemplate(broker.name, identityBlock)
      : broker.legalBasis === LegalBasis.ccpa
      ? ccpaOptOutTemplate(broker.name, identityBlock)
      : genericOptOutTemplate(broker.name, identityBlock);

  return { subject, body, discoveryKeysUsed: keysUsed };
}
