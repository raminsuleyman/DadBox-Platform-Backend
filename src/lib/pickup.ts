import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buffer: Buffer): string { let bits=0, value=0, result=''; for (const byte of buffer) { value=(value<<8)|byte; bits+=8; while (bits>=5) { result+=alphabet[(value >>> (bits-5)) & 31]; bits-=5; } } if (bits>0) result+=alphabet[(value << (5-bits)) & 31]; return result; }
export function pickupCode(id: string,nonce: string): string { const bytes=createHmac('sha256',config.PICKUP_SECRET).update(`paybox-code-v1:${id}:${nonce}`).digest(); const code=base32(bytes).slice(0,12); return `${code.slice(0,4)}-${code.slice(4,8)}-${code.slice(8,12)}`; }
export function codeDigest(code: string): string { return createHmac('sha256',config.PICKUP_SECRET).update(`paybox-verify:${normalize(code)}`).digest('hex'); }
export function normalize(code: string): string { return code.replace(/[-\s]/g,'').toUpperCase(); }
export function matchesCode(input: string, storedHash: string): boolean { const a=Buffer.from(codeDigest(input),'hex'); const b=Buffer.from(storedHash,'hex'); return a.length===b.length && timingSafeEqual(a,b); }
export function requestDigest(value: unknown): string { return createHmac('sha256',config.PICKUP_SECRET).update(`paybox-idempotency:${JSON.stringify(value)}`).digest('hex'); }
