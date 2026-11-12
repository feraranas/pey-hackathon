import type { Channel, Delivery, WhatsAppPort } from "./contracts.js";

type Session = WhatsAppPort & { readonly ready?: boolean };

export class RoutedWhatsApp implements WhatsAppPort {
  constructor(private readonly sessions: Record<Channel, Session>) {}
  get ready(): boolean {
    return Object.values(this.sessions).every((s) => s.ready !== false);
  }
  deliver(item: Delivery): Promise<void> {
    return this.sessions[item.channel].deliver(item);
  }
}
