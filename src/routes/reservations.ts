import { Router } from 'express';
import type { PoolClient } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool, transaction } from '../lib/db.js';
import { HttpError, asyncHandler, ok, list, page, parse } from '../lib/http.js';
import { requireAuth, requireRole, requireVerified, type Actor } from '../middleware/auth.js';
import { pickupCode, codeDigest, matchesCode, requestDigest } from '../lib/pickup.js';
import { id, reason, orderStatus } from '../lib/validation.js';

const router=Router();
const columns=`r.id,r.customer_id,r.business_id,r.surprise_box_id AS box_id,r.quantity,r.unit_price_minor,r.total_price_minor,r.currency,r.status,r.box_title,r.business_name,r.pickup_address,r.pickup_start,r.pickup_end,r.picked_up_at,r.cancelled_at,r.cancel_reason,r.created_at,r.updated_at,r.code_nonce,r.code_hash`;
const effective=`CASE WHEN r.status IN ('PENDING','CONFIRMED') AND r.pickup_end <= now() THEN 'EXPIRED' ELSE r.status END`;
function dto(row: any, actorId: string, replayCode=false) {
  const {code_nonce,code_hash,...safe}=row; void code_hash;
  const expired=['PENDING','CONFIRMED'].includes(safe.status) && new Date(safe.pickup_end).getTime()<=Date.now();
  if (expired) safe.status='EXPIRED';
  return {...safe,pickup_code:row.customer_id===actorId && (replayCode || (safe.status==='CONFIRMED' && !expired)) ? pickupCode(row.id,code_nonce) : null};
}
function idempotencyKey(header: string | undefined): string { return parse(id,header); }
type Idempotency = {replay: boolean; response?: any; resourceId?: string; status?: number};
async function beginIdempotency(c:PoolClient, actorId:string,method:string,path:string,key:string,hash:string): Promise<Idempotency> {
  const inserted=await c.query(`INSERT INTO public.idempotency_records(actor_id,method,canonical_route,key,request_hash,http_status,response_json,resource_id,expires_at)
    VALUES($1,$2,$3,$4,$5,0,'{}'::jsonb,NULL,now()+interval '24 hours') ON CONFLICT(actor_id,method,canonical_route,key) DO NOTHING RETURNING key`,[actorId,method,path,key,hash]);
  if (inserted.rowCount) return {replay:false};
  const result=await c.query('SELECT request_hash,http_status,response_json,resource_id FROM public.idempotency_records WHERE actor_id=$1 AND method=$2 AND canonical_route=$3 AND key=$4 FOR UPDATE',[actorId,method,path,key]);
  const row=result.rows[0];
  if (!row || row.request_hash!==hash) throw new HttpError(409,'IDEMPOTENCY_KEY_REUSED','Bu açar başqa sorğuda istifadə edilib.');
  if (!row.http_status) throw new HttpError(409,'CONFLICT','Əməliyyat hələ davam edir.');
  return {replay:true,response:row.response_json,resourceId:row.resource_id,status:row.http_status};
}
async function completeIdempotency(c:PoolClient,actorId:string,method:string,path:string,key:string,status:number,response:unknown,resourceId:string) {
  await c.query('UPDATE public.idempotency_records SET http_status=$5,response_json=$6::jsonb,resource_id=$7 WHERE actor_id=$1 AND method=$2 AND canonical_route=$3 AND key=$4',[actorId,method,path,key,status,JSON.stringify(response),resourceId]);
}
async function forgetIdempotency(c:PoolClient,actorId:string,method:string,path:string,key:string) { await c.query('DELETE FROM public.idempotency_records WHERE actor_id=$1 AND method=$2 AND canonical_route=$3 AND key=$4',[actorId,method,path,key]); }
async function lockProfiles(c:PoolClient,actor:Actor,ownerId:string,ownerMustBeActive=true) {
  const r=await c.query(`SELECT id,role,status FROM public.profiles WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE`,[[actor.id,ownerId]]);
  const self=r.rows.find(x=>x.id===actor.id), owner=r.rows.find(x=>x.id===ownerId);
  if (!self || self.status!=='ACTIVE' || self.role!==actor.role) throw new HttpError(403,'FORBIDDEN','Hesab artıq bu əməliyyatı edə bilmir.');
  if (!owner || (ownerMustBeActive && owner.status!=='ACTIVE')) throw new HttpError(409,'OFFER_UNAVAILABLE','Biznes hazırda əlçatan deyil.');
}
async function event(c:PoolClient,reservationId:string,actorId:string|null,from:string|null,to:string) {
  await c.query('INSERT INTO public.reservation_events(reservation_id,actor_id,from_status,to_status,occurred_at) VALUES($1,$2,$3,$4,clock_timestamp())',[reservationId,actorId,from,to]);
  await c.query('INSERT INTO public.outbox(event_type,aggregate_id,payload) VALUES($1,$2,$3::jsonb)',[`reservation.${to.toLowerCase()}`,reservationId,JSON.stringify({reservationId})]);
}
async function getLocked(c:PoolClient, reservationId:string,actor:Actor,ownerMustBeActive=true) {
  const refs=await c.query(`SELECT r.customer_id,r.business_id,r.surprise_box_id,b.owner_id FROM public.reservations r JOIN public.businesses b ON b.id=r.business_id WHERE r.id=$1`,[reservationId]);
  const ref=refs.rows[0]; if (!ref) throw new HttpError(404,'NOT_FOUND','Sifariş tapılmadı.');
  if (actor.id!==ref.customer_id && actor.id!==ref.owner_id) throw new HttpError(404,'NOT_FOUND','Sifariş tapılmadı.');
  await lockProfiles(c,actor,ref.owner_id,ownerMustBeActive);
  const b=(await c.query('SELECT id,owner_id,verification_status FROM public.businesses WHERE id=$1 FOR SHARE',[ref.business_id])).rows[0];
  if (!b || b.owner_id!==ref.owner_id) throw new HttpError(404,'NOT_FOUND','Biznes tapılmadı.');
  const box=(await c.query('SELECT id,business_id FROM public.surprise_boxes WHERE id=$1 FOR UPDATE',[ref.surprise_box_id])).rows[0];
  if (!box || box.business_id!==ref.business_id) throw new HttpError(404,'NOT_FOUND','Təklif tapılmadı.');
  const r=(await c.query(`SELECT ${columns} FROM public.reservations r WHERE r.id=$1 FOR UPDATE OF r`,[reservationId])).rows[0];
  if (!r || r.business_id!==ref.business_id || r.customer_id!==ref.customer_id) throw new HttpError(404,'NOT_FOUND','Sifariş tapılmadı.');
  return {r,b,ref};
}
async function databaseNow(c:PoolClient):Promise<number> { return new Date((await c.query('SELECT clock_timestamp() AS current_time')).rows[0].current_time).getTime(); }
function validBeforeEnd(r:any, timestamp:number) { if (new Date(r.pickup_end).getTime()<=timestamp) throw new HttpError(409,'PICKUP_WINDOW_CLOSED','Götürmə müddəti bitib.'); }

router.post('/reservations',requireAuth,requireRole('CUSTOMER','BUSINESS_OWNER'),requireVerified,asyncHandler(async(req,res)=>{
  const actor=req.actor!; const input=parse(z.object({boxId:id,quantity:z.number().int().min(1).max(20)}).strict(),req.body); const key=idempotencyKey(req.header('Idempotency-Key'));
  const path='/reservations', hash=requestDigest(input);
  const result=await transaction(async c=>{
    const idem=await beginIdempotency(c,actor.id,'POST',path,key,hash);
    if (idem.replay) { const r=(await c.query(`SELECT ${columns} FROM public.reservations r WHERE r.id=$1 AND r.customer_id=$2`,[idem.resourceId,actor.id])).rows[0]; if (!r) throw new HttpError(404,'NOT_FOUND','Sifariş tapılmadı.'); return {body:{...idem.response,pickup_code:pickupCode(r.id,r.code_nonce)},status:idem.status!}; }
    const refs=(await c.query('SELECT x.business_id,b.owner_id FROM public.surprise_boxes x JOIN public.businesses b ON b.id=x.business_id WHERE x.id=$1',[input.boxId])).rows[0];
    if (!refs) throw new HttpError(404,'NOT_FOUND','Təklif tapılmadı.');
    await lockProfiles(c,actor,refs.owner_id);
    const business=(await c.query('SELECT id,owner_id,name,address,verification_status FROM public.businesses WHERE id=$1 FOR SHARE',[refs.business_id])).rows[0];
    if (!business || business.owner_id!==refs.owner_id || business.verification_status!=='APPROVED') throw new HttpError(409,'OFFER_UNAVAILABLE','Təklif hazırda əlçatan deyil.');
    const box=(await c.query('SELECT * FROM public.surprise_boxes WHERE id=$1 FOR UPDATE',[input.boxId])).rows[0];
    const timestamp=await databaseNow(c);
    if (!box || box.business_id!==business.id || box.status!=='ACTIVE' || new Date(box.pickup_end).getTime()<=timestamp) throw new HttpError(409,'OFFER_UNAVAILABLE','Təklif hazırda əlçatan deyil.');
    if (box.available_quantity<input.quantity) throw new HttpError(409,'INSUFFICIENT_QUANTITY','Seçilmiş sayda qutu mövcud deyil.');
    await c.query('UPDATE public.surprise_boxes SET available_quantity=available_quantity-$2,updated_at=clock_timestamp() WHERE id=$1',[box.id,input.quantity]);
    const rid=randomUUID(),nonce=randomBytes(16).toString('hex'),code=pickupCode(rid,nonce);
    await c.query(`INSERT INTO public.reservations(id,customer_id,business_id,surprise_box_id,quantity,unit_price_minor,total_price_minor,currency,status,box_title,business_name,pickup_address,pickup_start,pickup_end,code_nonce,code_hash,code_key_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,'AZN','CONFIRMED',$8,$9,$10,$11,$12,$13,$14,1)`,[rid,actor.id,business.id,box.id,input.quantity,box.discounted_price_minor,box.discounted_price_minor*input.quantity,box.title,business.name,business.address,box.pickup_start,box.pickup_end,nonce,codeDigest(code)]);
    await event(c,rid,actor.id,null,'CONFIRMED');
    const row=(await c.query(`SELECT ${columns} FROM public.reservations r WHERE r.id=$1`,[rid])).rows[0];
    const redacted={...dto(row,actor.id),pickup_code:null};
    await completeIdempotency(c,actor.id,'POST',path,key,201,redacted,rid);
    return {body:{...redacted,pickup_code:code},status:201};
  });
  return ok(res,result.body,result.status);
}));
router.get('/reservations/me',requireAuth,requireRole('CUSTOMER','BUSINESS_OWNER'),asyncHandler(async(req,res)=>{
  const {page:pg,pageSize,offset}=page(req); const status=req.query.status===undefined?undefined:parse(orderStatus,req.query.status);
  const where=`r.customer_id=$1 AND ($2::text IS NULL OR ${effective}=$2)`;
  const count=(await pool.query(`SELECT count(*)::int AS n FROM public.reservations r WHERE ${where}`,[req.actor!.id,status??null])).rows[0].n;
  const rows=(await pool.query(`SELECT ${columns} FROM public.reservations r WHERE ${where} ORDER BY r.created_at DESC,r.id ASC LIMIT $3 OFFSET $4`,[req.actor!.id,status??null,pageSize,offset])).rows;
  return list(res,rows.map(r=>dto(r,req.actor!.id)),count,pg,pageSize);
}));
router.get('/businesses/:id/reservations',requireAuth,requireRole('BUSINESS_OWNER'),asyncHandler(async(req,res)=>{
  const businessId=parse(id,req.params.id),{page:pg,pageSize,offset}=page(req); const status=req.query.status===undefined?undefined:parse(orderStatus,req.query.status); const boxId=req.query.boxId===undefined?undefined:parse(id,req.query.boxId);
  const owner=(await pool.query('SELECT id FROM public.businesses WHERE id=$1 AND owner_id=$2',[businessId,req.actor!.id])).rows[0]; if (!owner) throw new HttpError(404,'NOT_FOUND','Biznes tapılmadı.');
  const where=`r.business_id=$1 AND ($2::text IS NULL OR ${effective}=$2) AND ($3::uuid IS NULL OR r.surprise_box_id=$3)`;
  const count=(await pool.query(`SELECT count(*)::int AS n FROM public.reservations r WHERE ${where}`,[businessId,status??null,boxId??null])).rows[0].n;
  const rows=(await pool.query(`SELECT ${columns} FROM public.reservations r WHERE ${where} ORDER BY r.created_at DESC,r.id ASC LIMIT $4 OFFSET $5`,[businessId,status??null,boxId??null,pageSize,offset])).rows;
  return list(res,rows.map(r=>dto(r,req.actor!.id)),count,pg,pageSize);
}));
router.get('/reservations/:id',requireAuth,requireRole('CUSTOMER','BUSINESS_OWNER'),asyncHandler(async(req,res)=>{
  const rid=parse(id,req.params.id); const r=(await pool.query(`SELECT ${columns} FROM public.reservations r JOIN public.businesses b ON b.id=r.business_id WHERE r.id=$1 AND (r.customer_id=$2 OR b.owner_id=$2)`,[rid,req.actor!.id])).rows[0];
  if (!r) throw new HttpError(404,'NOT_FOUND','Sifariş tapılmadı.'); return ok(res,dto(r,req.actor!.id));
}));
router.patch('/reservations/:id/confirm',requireAuth,requireRole('BUSINESS_OWNER'),requireVerified,asyncHandler(async(req,res)=>{
  const rid=parse(id,req.params.id); parse(z.object({}).strict(),req.body); const actor=req.actor!;
  const response=await transaction(async c=>{ const {r,b}=await getLocked(c,rid,actor); if (b.owner_id!==actor.id || b.verification_status!=='APPROVED') throw new HttpError(404,'NOT_FOUND','Sifariş tapılmadı.'); validBeforeEnd(r,await databaseNow(c)); if (r.status!=='PENDING') throw new HttpError(409,'INVALID_TRANSITION','Bu sifariş təsdiqlənə bilməz.'); await c.query("UPDATE public.reservations SET status='CONFIRMED',updated_at=clock_timestamp() WHERE id=$1",[rid]); await event(c,rid,actor.id,'PENDING','CONFIRMED'); return dto({...r,status:'CONFIRMED',updated_at:new Date()},actor.id); });
  return ok(res,response);
}));
router.patch('/reservations/:id/cancel',requireAuth,requireRole('CUSTOMER','BUSINESS_OWNER'),requireVerified,asyncHandler(async(req,res)=>{
  const rid=parse(id,req.params.id); const input=parse(z.object({reason:reason.nullable()}).strict(),req.body); const key=idempotencyKey(req.header('Idempotency-Key')); const actor=req.actor!,path=`/reservations/${rid}/cancel`,hash=requestDigest(input);
  const result=await transaction(async c=>{
    const idem=await beginIdempotency(c,actor.id,'PATCH',path,key,hash); if (idem.replay) return {body:idem.response,status:idem.status!};
    const {r,b}=await getLocked(c,rid,actor,false); const owner=b.owner_id===actor.id,customer=r.customer_id===actor.id; const timestamp=await databaseNow(c); validBeforeEnd(r,timestamp);
    if (!['PENDING','CONFIRMED'].includes(r.status)) throw new HttpError(409,'INVALID_TRANSITION','Bu sifariş ləğv edilə bilməz.');
    if (customer && !owner && new Date(r.pickup_start).getTime()<=timestamp) throw new HttpError(409,'CANCELLATION_WINDOW_CLOSED','Müştəri üçün ləğv müddəti bitib.');
    if (owner && !input.reason) throw new HttpError(422,'VALIDATION_ERROR','Biznes ləğv səbəbini qeyd etməlidir.');
    await c.query('UPDATE public.surprise_boxes SET available_quantity=available_quantity+$2,updated_at=clock_timestamp() WHERE id=$1',[r.box_id,r.quantity]);
    await c.query("UPDATE public.reservations SET status='CANCELLED',cancelled_at=clock_timestamp(),cancel_reason=$2,updated_at=clock_timestamp() WHERE id=$1",[rid,input.reason]);
    await event(c,rid,actor.id,r.status,'CANCELLED'); const row=(await c.query(`SELECT ${columns} FROM public.reservations r WHERE r.id=$1`,[rid])).rows[0]; const body=dto(row,actor.id);
    await completeIdempotency(c,actor.id,'PATCH',path,key,200,body,rid); return {body,status:200};
  }); return ok(res,result.body,result.status);
}));
router.patch('/reservations/:id/pickup',requireAuth,requireRole('BUSINESS_OWNER'),requireVerified,asyncHandler(async(req,res)=>{
  const rid=parse(id,req.params.id),input=parse(z.object({pickupCode:z.string().trim().min(4).max(40)}).strict(),req.body),key=idempotencyKey(req.header('Idempotency-Key')); const actor=req.actor!,path=`/reservations/${rid}/pickup`,hash=requestDigest(input);
  const result=await transaction(async c=>{
    const idem=await beginIdempotency(c,actor.id,'PATCH',path,key,hash); if (idem.replay) return {body:idem.response,status:idem.status!};
    const {r,b}=await getLocked(c,rid,actor); if (b.owner_id!==actor.id || b.verification_status!=='APPROVED') throw new HttpError(404,'NOT_FOUND','Sifariş tapılmadı.'); const timestamp=await databaseNow(c); validBeforeEnd(r,timestamp);
    if (r.status!=='CONFIRMED') throw new HttpError(409,'INVALID_TRANSITION','Sifariş götürülə bilməz.');
    if (new Date(r.pickup_start).getTime()>timestamp) throw new HttpError(409,'PICKUP_WINDOW_CLOSED','Götürmə vaxtı hələ başlamayıb.');
    await c.query(`INSERT INTO public.pickup_attempts(reservation_id,actor_id,failed_count,window_start) VALUES($1,$2,0,clock_timestamp()) ON CONFLICT(reservation_id,actor_id) DO NOTHING`,[rid,actor.id]);
    const attempt=(await c.query('SELECT * FROM public.pickup_attempts WHERE reservation_id=$1 AND actor_id=$2 FOR UPDATE',[rid,actor.id])).rows[0];
    if (attempt.locked_until && new Date(attempt.locked_until).getTime()>timestamp) { await forgetIdempotency(c,actor.id,'PATCH',path,key); return {failure:new HttpError(429,'PICKUP_ATTEMPTS_EXCEEDED','Çox sayda yanlış cəhd. 15 dəqiqə sonra yenidən yoxlayın.'),status:429}; }
    if (!matchesCode(input.pickupCode,r.code_hash)) {
      const stale=timestamp-new Date(attempt.window_start).getTime()>15*60_000; const failed=(stale?0:attempt.failed_count)+1;
      await c.query(`UPDATE public.pickup_attempts SET failed_count=$3,window_start=CASE WHEN $4 THEN clock_timestamp() ELSE window_start END,locked_until=CASE WHEN $3>=5 THEN clock_timestamp()+interval '15 minutes' ELSE NULL END WHERE reservation_id=$1 AND actor_id=$2`,[rid,actor.id,failed,stale]);
      await forgetIdempotency(c,actor.id,'PATCH',path,key); return {failure:new HttpError(failed>=5?429:409,failed>=5?'PICKUP_ATTEMPTS_EXCEEDED':'INVALID_PICKUP_CODE',failed>=5?'Çox sayda yanlış cəhd. 15 dəqiqə sonra yenidən yoxlayın.':'Götürmə kodu yanlışdır.'),status:failed>=5?429:409};
    }
    await c.query('DELETE FROM public.pickup_attempts WHERE reservation_id=$1 AND actor_id=$2',[rid,actor.id]);
    await c.query("UPDATE public.reservations SET status='PICKED_UP',picked_up_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1",[rid]); await event(c,rid,actor.id,'CONFIRMED','PICKED_UP');
    const row=(await c.query(`SELECT ${columns} FROM public.reservations r WHERE r.id=$1`,[rid])).rows[0]; const body=dto(row,actor.id);
    await completeIdempotency(c,actor.id,'PATCH',path,key,200,body,rid); return {body,status:200};
  });
  if ('failure' in result && result.failure) { if (result.status===429) res.setHeader('Retry-After','900'); throw result.failure; }
  return ok(res,result.body,result.status);
}));
export default router;
