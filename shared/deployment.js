// The frontend is served independently of Render's free, sleeping API service.
export const FRONTEND_ORIGIN = 'https://emtidad-alelm.taqialhrainy.chatgpt.site';
export const BACKEND_ORIGIN = 'https://emtidad-alelm.onrender.com';
// Existing authorized JavaScript origin for the current Google OAuth client.
export const GOOGLE_SIGNIN_ORIGIN = 'https://mnasah.onrender.com';
export function paymentReturnOrigin(req, fallback) {
  return req.headers?.origin === FRONTEND_ORIGIN ? FRONTEND_ORIGIN : fallback;
}
