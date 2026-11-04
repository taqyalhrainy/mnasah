export function allowNavigation() {
  return window.dispatchEvent(new Event('platform-before-navigate', { cancelable: true }));
}
