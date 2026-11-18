import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { supabaseAuth } from '../lib/supabase.js';
import { pool } from '../lib/db.js';
import { HttpError, asyncHandler } from '../lib/http.js';

export type Role = 'CUSTOMER' | 'BUSINESS_OWNER' | 'ADMIN';
export interface Actor { id: string; role: Role; status: 'ACTIVE' | 'SUSPENDED'; email: string; emailVerified: boolean }
async function authenticate(req: Request): Promise<void> {
  const h=req.header('authorization');
  if (!h) throw new HttpError(401,'UNAUTHENTICATED','Daxil olun.');
  const match=/^Bearer\s+([^\s]+)$/i.exec(h);
  if (!match) throw new HttpError(401,'TOKEN_INVALID','Sessiya etibarlı deyil.');
  const {data,error}=await supabaseAuth.auth.getUser(match[1]);
  if (error || !data.user) {
    if (error && typeof error.status === 'number' && error.status >= 500) throw new HttpError(503,'SERVICE_UNAVAILABLE','Autentifikasiya xidməti əlçatan deyil.');
    throw new HttpError(401,'TOKEN_INVALID','Sessiya etibarlı deyil.');
  }
  const result=await pool.query('SELECT id, role, status FROM public.profiles WHERE id=$1',[data.user.id]);
  const profile=result.rows[0];
  if (!profile) throw new HttpError(403,'FORBIDDEN','Profil tapılmadı.');
  if (profile.status !== 'ACTIVE') throw new HttpError(403,'ACCOUNT_SUSPENDED','Hesab bloklanıb.');
  req.actor={id:profile.id,role:profile.role,status:profile.status,email:data.user.email??'',emailVerified:!!data.user.email_confirmed_at};
}
export const requireAuth: RequestHandler = asyncHandler(async (req,_res,next)=>{ await authenticate(req); next(); });
export const optionalAuth: RequestHandler = asyncHandler(async (req,_res,next)=>{ if (req.header('authorization')) await authenticate(req); next(); });
export const requireVerified: RequestHandler = (req:Request,_res:Response,next:NextFunction) => { if (!req.actor) return next(new HttpError(401,'UNAUTHENTICATED','Daxil olun.')); if (!req.actor.emailVerified) return next(new HttpError(403,'EMAIL_NOT_VERIFIED','E-poçt ünvanınızı təsdiqləyin.')); next(); };
export const requireRole = (...roles: Role[]): RequestHandler => (req,_res,next) => { if (!req.actor) return next(new HttpError(401,'UNAUTHENTICATED','Daxil olun.')); if (!roles.includes(req.actor.role)) return next(new HttpError(403,'FORBIDDEN','Bu əməliyyat üçün icazəniz yoxdur.')); next(); };
