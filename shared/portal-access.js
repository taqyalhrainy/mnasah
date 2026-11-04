// Routing separation complements (and never replaces) account-role authorization.
export const OWNER_PORTAL_ORIGIN = 'https://emtidad-alelm-owner.taqialhrainy.chatgpt.site';
export function publicOwnerPage(pathname, hostname) {
  return ['emtidad-alelm.onrender.com', 'mnasah.onrender.com'].includes(hostname.toLowerCase()) && /^\/(?:owner|admin)(?:\/|$)/i.test(decodeURIComponent(pathname));
}

export function portalRoleAllowed(role, mode = 'all') {
  return mode === 'owner' ? role === 'admin' : mode === 'public' ? role !== 'admin' : true;
}

export function portalRequestAllowed(pathname, role, mode = 'all') {
  if (mode === 'all') return true;
  if (/^\/api\/auth(?:\/|$)/.test(pathname)) return !role || portalRoleAllowed(role, mode);
  if (mode === 'public') return !/^\/(?:owner|admin)(?:\/|$)/.test(pathname) && !/^\/api\/admin(?:\/|$)/.test(pathname);
  if (/^\/api\/(?:students|teachers)(?:\/|$)/.test(pathname)) return false;
  return !/^\/(?:students|teachers|video|video-test)(?:\/|$)/.test(pathname);
}
