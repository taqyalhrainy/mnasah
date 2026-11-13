import { request, type Portal } from './platformApi';

const decodeVapidKey = (value: string) => {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
};

export async function ensureDevicePush(portal: Portal, askPermission = false) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  let permission = Notification.permission;
  if (permission === 'default' && askPermission) permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const config = await request<{ vapidPublicKey?: string }>('public/config');
  if (!config.vapidPublicKey) throw new Error('تعذر تفعيل تنبيهات الهاتف مؤقتًا. أعد المحاولة.');
  const registration = await readyPushWorker();
  let subscription = await registration.pushManager.getSubscription();
  const publicKey = decodeVapidKey(config.vapidPublicKey);
  if (subscription?.options?.applicationServerKey) {
    const previousKey = new Uint8Array(subscription.options.applicationServerKey);
    if (previousKey.length !== publicKey.length || !previousKey.every((value, index) => value === publicKey[index])) { await subscription.unsubscribe(); subscription = null; }
  }
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
  await request(`${portal}/push/subscribe`, { subscription: subscription.toJSON() });
  return true;
}

export async function removeDevicePush(portal: Portal) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await request(`${portal}/push/unsubscribe`, { endpoint: subscription.endpoint }).catch(() => undefined);
  await subscription.unsubscribe();
}

export function readyPushWorker(): Promise<ServiceWorkerRegistration> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('تعذر تجهيز التنبيهات. أعد فتح التطبيق وحاول مجددًا.')), 12000);
    navigator.serviceWorker.ready.then(registration => { window.clearTimeout(timer); resolve(registration); }, error => { window.clearTimeout(timer); reject(error); });
  });
}

export async function devicePushEnabled(portal: Portal) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  const registration = await readyPushWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return false;
  // The local subscription is authoritative for the permission prompt. A temporary
  // server/network failure must not tell an already subscribed device to allow again.
  const result = await request<{ enabled: boolean }>(`${portal}/push/status`, { endpoint: subscription.endpoint }).catch(() => null);
  if (result && !result.enabled) await request(`${portal}/push/subscribe`, { subscription: subscription.toJSON() });
  return true;
}

export async function testDevicePush(portal: Portal) {
  const subscription = await (await readyPushWorker()).pushManager.getSubscription();
  if (!subscription) throw new Error('فعّل التنبيهات أولًا.');
  await request(`${portal}/push/test`, { endpoint: subscription.endpoint });
}
