const HOUR = 60 * 60 * 1000;

function clampPercent(value, fallback = 20) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : fallback;
}

/**
 * Produce one authoritative cancellation quote for both backends and the UI.
 * Monetary values are integer fils/cents, matching booking.price.
 */
export function cancellationQuote({ start, price, actorRole, now = Date.now(), commissionPercent = 20 }) {
  const total = Math.max(0, Math.round(Number(price) || 0));
  const hoursBefore = (Number(start) - Number(now)) / HOUR;
  const teacherCancellation = actorRole === 'teachers' || actorRole === 'admin';

  if (teacherCancellation) {
    return {
      tier: 'teacher_cancelled',
      hoursBefore,
      refund: total,
      teacherCompensation: 0,
      platformFee: 0,
      refundPercent: 100,
    };
  }

  if (hoursBefore >= 24) {
    return {
      tier: 'student_24h',
      hoursBefore,
      refund: total,
      teacherCompensation: 0,
      platformFee: 0,
      refundPercent: 100,
    };
  }

  const refund = hoursBefore >= 6 ? Math.round(total * 0.5) : 0;
  const forfeited = total - refund;
  const platformFee = Math.round(forfeited * clampPercent(commissionPercent) / 100);
  return {
    tier: hoursBefore >= 6 ? 'student_6h' : 'student_late',
    hoursBefore,
    refund,
    teacherCompensation: forfeited - platformFee,
    platformFee,
    refundPercent: hoursBefore >= 6 ? 50 : 0,
  };
}

