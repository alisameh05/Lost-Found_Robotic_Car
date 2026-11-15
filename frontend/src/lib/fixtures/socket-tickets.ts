import type { Channel } from "@/generated/api-v1";
import { socketOffer, type ClientContext, type SocketOffer } from "../transport";
import { fixtureError, fixtureOk } from "./responses";

export function runtimeToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function openSocketTickets(monotonic: () => number, serverTime: () => number) {
  const tickets = new Map<string, { boot: string; client: string; channel: Channel; deadline: number; consumed: boolean }>();

  return {
    issue(context: ClientContext, channel: Channel) {
      const time = monotonic();
      let outstanding = 0;
      for (const [token, ticket] of tickets) {
        if (ticket.deadline <= time) tickets.delete(token);
        else if (ticket.client === context.client_id && !ticket.consumed) outstanding++;
      }
      if (outstanding >= 32 || tickets.size >= 8192) return fixtureError(503, "CAPACITY_REACHED", "Too many sample tickets.");
      const ticket = runtimeToken();
      tickets.set(ticket, { boot: context.backend_boot_id, client: context.client_id, channel, deadline: time + 10_000, consumed: false });
      return fixtureOk({ ticket, expires_at_ms: serverTime() + 10_000 });
    },
    redeem(context: ClientContext, channel: Channel, offer: SocketOffer) {
      const invalid = () => fixtureError(403, "TICKET_INVALID", "The channel ticket is invalid.");
      const [version, credential] = offer.protocols;
      if (offer.protocols.length !== 2 || version !== "laf.v1" || !credential.startsWith("laf.ticket.")) return invalid();
      const token = credential.slice("laf.ticket.".length);
      const ticket = tickets.get(token);
      if (!ticket || ticket.boot !== context.backend_boot_id || ticket.client !== context.client_id ||
          ticket.channel !== channel || offer.path !== socketOffer(channel, token).path) return invalid();
      if (monotonic() >= ticket.deadline) {
        tickets.delete(token);
        return fixtureError(403, "TICKET_EXPIRED", "The channel ticket expired.");
      }
      if (ticket.consumed) return fixtureError(403, "TICKET_CONSUMED", "The channel ticket was already used.");
      ticket.consumed = true;
      return fixtureOk("laf.v1" as const);
    },
    clear() { tickets.clear(); },
  };
}
