export function validPushSubscription(subscription) {
  try {
    const url = new URL(subscription?.endpoint);
    const host = url.hostname;
    const allowed = host === 'fcm.googleapis.com' || host === 'web.push.apple.com' || host.endsWith('.push.apple.com') || host === 'updates.push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
    const { p256dh, auth } = subscription?.keys || {};
    return allowed && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && /^[\w-]+={0,2}$/.test(p256dh || '') && /^[\w-]+={0,2}$/.test(auth || '') && Buffer.from(p256dh, 'base64url').length === 65 && Buffer.from(auth, 'base64url').length === 16;
  } catch { return false; }
}

export async function deliverDevicePush(db, send, userId, payload, endpoint) {
  const rows = await db.collection('push_subscriptions').find({ user_id: userId, ...(endpoint ? { endpoint } : {}) }, { projection: { _id: 0 } }).limit(100).toArray();
  let sent = 0;
  await Promise.all(rows.map(async row => {
    try {
      if (!validPushSubscription(row.subscription)) return;
      await send(row.subscription, JSON.stringify(payload), { TTL: 86400, urgency: 'high', timeout: 10000 });
      sent++;
    } catch (error) {
      if ([404, 410].includes(Number(error?.statusCode))) await db.collection('push_subscriptions').deleteOne({ endpoint: row.endpoint, user_id: userId });
    }
  }));
  return { sent };
}

export async function notifyPlatformOwners(db, send, notice) {
  const owners = await db.collection('users').find({ role: 'admin', status: 'active' }, { projection: { _id: 0, id: 1 } }).toArray();
  await Promise.all(owners.map(owner => send(owner.id, { title: notice.title, body: notice.body, tag: `admin-${notice.id}`, url: `/owner?view=${encodeURIComponent(notice.view)}` })));
}
