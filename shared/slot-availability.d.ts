type AvailableSlot = { start: number; minutes: number; price?: number; status?: string; available_until?: number; offerings?: Array<{ minutes: number; price: number }>; booked_ranges?: Array<{ start: number; end: number }>; reservations?: Array<{ start: number; end: number }>; withdrawn_ranges?: Array<{ start: number; end: number }> };
export function bookingStarts(slot: AvailableSlot, minutes: number, now?: number): number[];
export function slotAvailability(slot: AvailableSlot, now?: number): { available: boolean; reason: string };
