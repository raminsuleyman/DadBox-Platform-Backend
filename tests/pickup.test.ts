import { describe, expect, it } from 'vitest';
import { codeDigest, matchesCode, normalize, pickupCode, requestDigest } from '../src/lib/pickup.js';
import { toCamel } from '../src/lib/http.js';
describe('pickup code',()=>{
  it('generates a reproducible 12-character code and checks its HMAC',()=>{ const id='11111111-1111-4111-8111-111111111111'; const c=pickupCode(id,'nonce'); expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/); expect(pickupCode(id,'nonce')).toBe(c); expect(matchesCode(c,codeDigest(c))).toBe(true); expect(matchesCode('AAAA-AAAA-AAAA',codeDigest(c))).toBe(c==='AAAA-AAAA-AAAA'); });
  it('normalizes input and binds idempotency digest to request body',()=>{ expect(normalize('ab-cd ef')).toBe('ABCDEF'); expect(requestDigest({quantity:1})).not.toBe(requestDigest({quantity:2})); });
  it('formats nested database fields without exposing server internals',()=>{ expect(toCamel({pickup_start:'a', child:{total_price_minor:123}})).toEqual({pickupStart:'a',child:{totalPriceMinor:123}}); });
});
