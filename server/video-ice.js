const stun = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const urlsOf = server => (Array.isArray(server?.urls) ? server.urls : [server?.urls]).filter(url => typeof url === 'string' && /^(stun|turn|turns):/.test(url));
const validServers = servers => (Array.isArray(servers) ? servers : servers ? [servers] : []).flatMap(server => {
  const urls = urlsOf({ ...server, urls: server?.urls || server?.url });
  if (!urls.length || urls.some(url => /^turns?:/.test(url)) && !(server.username && server.credential)) return [];
  return [{ urls, ...(server.username && server.credential ? { username: server.username, credential: server.credential } : {}) }];
});

export function createVideoIceProvider({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  let cache, refreshAt = 0, expiresAt = 0, retryAt = 0, flight;
  const result = servers => { const relay = servers.some(server => urlsOf(server).some(url => /^turns?:/.test(url))); return { ice_servers: servers, relay_available: relay, ice_transport_policy: relay && env.VIDEO_RELAY_ONLY === 'true' ? 'relay' : 'all' }; };
  return async () => {
    const urls = String(env.TURN_URLS || env.TURN_URL || env.VITE_TURN_URLS || env.VITE_TURN_URL || '').split(',').map(value => value.trim()).filter(Boolean);
    const username = env.TURN_USERNAME || env.VITE_TURN_USERNAME, credential = env.TURN_CREDENTIAL || env.VITE_TURN_CREDENTIAL;
    if (urls.length && username && credential) return result([...stun, ...validServers([{ urls, username, credential }])]);
    if (cache && now() < refreshAt) return result(cache);
    if (now() < retryAt) return result(cache && now() < expiresAt ? cache : stun);
    if (flight) return flight;
    flight = (async () => {
      try {
        let servers;
        if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
          const response = await fetchImpl(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CLOUDFLARE_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
            method: 'POST', headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 3600 }), signal: AbortSignal.timeout(4000),
          });
          if (!response.ok) throw new Error('Relay provider unavailable');
          servers = validServers((await response.json()).iceServers);
        } else if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
          const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Tokens.json`, {
            method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}` }, body: new URLSearchParams({ Ttl: '3600' }), signal: AbortSignal.timeout(4000),
          });
          if (!response.ok) throw new Error('Relay provider unavailable');
          servers = validServers((await response.json()).ice_servers);
        }
        if (!servers?.some(server => urlsOf(server).some(url => /^turns?:/.test(url)))) {
          retryAt = now() + 30000;
          return result(cache && now() < expiresAt ? cache : stun);
        }
        cache = [...stun, ...servers]; refreshAt = now() + 300000; expiresAt = now() + 3540000;
        return result(cache);
      } catch {
        retryAt = now() + 30000;
        return result(cache && now() < expiresAt ? cache : stun);
      }
    })();
    try { return await flight; } finally { flight = undefined; }
  };
}
