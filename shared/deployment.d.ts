export const FRONTEND_ORIGIN: string;
export const BACKEND_ORIGIN: string;
export function paymentReturnOrigin(req: { headers?: { origin?: string } }, fallback: string): string;
