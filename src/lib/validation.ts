import { z } from 'zod';
export const id = z.string().uuid();
export const reason = z.string().trim().min(5).max(500);
export const iso = z.string().datetime({ offset: true });
export const orderStatus = z.enum(['PENDING','CONFIRMED','PICKED_UP','CANCELLED','EXPIRED']);
