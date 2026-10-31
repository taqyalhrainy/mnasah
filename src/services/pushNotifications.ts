import { request, type Portal } from './platformApi';

const decodeVapidKey = (value: string) => {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
};

export async function ensureDevicePush(portal: Portal, askPermission = false) {
  if (portal === 'admin' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  let permission = Notification.permission;
  if (permission === 'default' && askPermission) permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;
  const configResponse = await fetch(`${(import.meta.env.VITE_API_URL || '').replace(/\/$/, '')}/api/public/config`, { credentials: 'include', cache: 'no-store' });
  const config = await configResponse.json() as { vapidPublicKey?: string };
  if (!config.vapidPublicKey) return false;
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapidKey(config.vapidPublicKey) });
  await request(`${portal}/push/subscribe`, { subscription: subscription.toJSON() });
  return true;
}

export async function removeDevicePush(portal: Portal) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await request(`${portal}/push/unsubscribe`, { endpoint: subscription.endpoint }).catch(() => undefined);
  await subscription.unsubscribe();
}
