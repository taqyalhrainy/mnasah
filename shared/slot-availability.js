export function bookingStarts(slot, minutes, now = Date.now()) {
  if (!Number.isFinite(minutes) || minutes <= 0 || slot.status === 'cancelled') return [];
  const end = Number(slot.available_until || slot.start + slot.minutes * 60000);
  const step = 5 * 60000;
  const first = Number(slot.start) + Math.max(0, Math.ceil((now + 1000 - Number(slot.start)) / step)) * step;
  const occupied = slot.booked_ranges || slot.reservations || [];
  const starts = [];
  for (let start = first; start + minutes * 60000 <= end; start += step) {
    if (!occupied.some(range => start < range.end && start + minutes * 60000 > range.start)) starts.push(start);
  }
  return starts;
}
export function slotAvailability(slot, now = Date.now()) {
  if (slot.status === 'cancelled') return { available: false, reason: 'تم إلغاء هذا الموعد.' };
  const end = Number(slot.available_until || slot.start + slot.minutes * 60000);
  if (end <= now) return { available: false, reason: 'انتهت الفترة المتاحة.' };
  const offerings = slot.offerings?.length ? slot.offerings : [{ minutes: slot.minutes, price: slot.price }];
  if (offerings.some(item => bookingStarts(slot, Number(item.minutes), now).length)) return { available: true, reason: '' };
  return { available: false, reason: (slot.booked_ranges || slot.reservations || []).length ? 'حُجز الوقت المتاح، ولا توجد فترة متبقية تتسع لحصة.' : 'الوقت المتبقي أقل من مدة الحصة. انشر فترة جديدة ليستطيع الطلاب الحجز.' };
}
