import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../lib/db.js';
import { asyncHandler, HttpError, ok, parse } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
const router=Router();
const profileFields='id, full_name, phone, role, status, created_at, updated_at';
router.get('/auth/me',requireAuth,asyncHandler(async(req,res)=>{
  const r=await pool.query(`SELECT ${profileFields} FROM public.profiles WHERE id=$1`,[req.actor!.id]);
  if (!r.rows[0]) throw new HttpError(404,'NOT_FOUND','Profil tapılmadı.');
  return ok(res,{...r.rows[0],email:req.actor!.email,email_verified:req.actor!.emailVerified});
}));
router.patch('/users/me',requireAuth,asyncHandler(async(req,res)=>{
  const input=parse(z.object({fullName:z.string().trim().min(2).max(120).optional(),phone:z.string().regex(/^\+[1-9]\d{7,14}$/).nullable().optional()}).strict().refine(x=>Object.keys(x).length>0,'Ən azı bir sahə daxil edin.'),req.body);
  if (input.phone !== undefined && !req.actor!.emailVerified) throw new HttpError(403,'EMAIL_NOT_VERIFIED','Telefonu dəyişmək üçün e-poçtu təsdiqləyin.');
  const r=await pool.query(`UPDATE public.profiles SET full_name=COALESCE($2,full_name), phone=CASE WHEN $3::boolean THEN $4 ELSE phone END,updated_at=now() WHERE id=$1 AND status='ACTIVE' RETURNING ${profileFields}`,[req.actor!.id,input.fullName??null,input.phone!==undefined,input.phone??null]);
  if (!r.rows[0]) throw new HttpError(404,'NOT_FOUND','Profil tapılmadı.');
  return ok(res,{...r.rows[0],email:req.actor!.email,email_verified:req.actor!.emailVerified});
}));
export default router;
