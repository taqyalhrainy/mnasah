export const FRONTEND_ORIGIN: string;
export const BACKEND_ORIGIN: string;
export const GOOGLE_SIGNIN_ORIGIN: string;
export function paymentReturnOrigin(req: { headers?: { origin?: string } }, fallback: string): string;
