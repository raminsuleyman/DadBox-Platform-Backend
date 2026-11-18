import type { Actor } from '../middleware/auth.js';
declare global { namespace Express { interface Request { actor?: Actor; requestId?: string } } }
export {};
