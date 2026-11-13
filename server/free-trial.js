const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const FREE_TRIAL_MINUTES = 30;

export async function freeTrialStatus(db, studentId) {
  let user = await db.collection('users').findOne({ id: studentId, role: 'students' });
  if (!user) return { available: false, minutes: FREE_TRIAL_MINUTES };
  if (!user.free_trial_granted_at) {
    // A new learner keeps the credit indefinitely, even if they later buy a
    // paid lesson. Existing learners with booking/purchase history do not get it.
    const previousLesson = await db.collection('bookings').findOne({ student_id: studentId, is_free_trial: { $ne: true } });
    const previousPackage = await db.collection('package_purchases').findOne({ student_id: studentId });
    if (previousLesson || previousPackage) return { available: false, minutes: FREE_TRIAL_MINUTES };
    await db.collection('users').updateOne({ id: studentId, role: 'students', free_trial_granted_at: { $exists: false } }, { $set: { free_trial_granted_at: Date.now() } });
    user = await db.collection('users').findOne({ id: studentId, role: 'students' });
  }
  return { available: Boolean(user.free_trial_granted_at && !user.free_trial_booking_id), minutes: FREE_TRIAL_MINUTES };
}

export async function claimFreeTrial(db, studentId, bookingId, teacher) {
  if (teacher?.status !== 'active' || teacher?.free_trial_enabled !== true) fail(409, 'هذا الأستاذ لا يقدّم حصة مجانية حالياً.');
  if (!(await freeTrialStatus(db, studentId)).available) fail(409, 'الحصة المجانية مستخدمة أو محجوزة مسبقاً.');
  const result = await db.collection('users').updateOne({ id: studentId, role: 'students', free_trial_booking_id: { $exists: false } }, { $set: { free_trial_booking_id: bookingId, free_trial_claimed_at: Date.now() } });
  if (!result.modifiedCount) fail(409, 'الحصة المجانية مستخدمة أو محجوزة مسبقاً.');
}

export async function releaseFreeTrial(db, booking) {
  if (!booking?.is_free_trial) return;
  await db.collection('users').updateOne({ id: booking.student_id, free_trial_booking_id: booking.id }, { $unset: { free_trial_booking_id: '', free_trial_claimed_at: '' } });
}
