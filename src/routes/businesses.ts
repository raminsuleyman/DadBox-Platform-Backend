import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from '../lib/db.js';
import { HttpError, asyncHandler, ok, list, parse, page } from '../lib/http.js';
import { requireAuth, requireVerified, requireRole } from '../middleware/auth.js';

const router = Router();
const category = z.enum(['BAKERY', 'CAFE', 'RESTAURANT', 'SUPERMARKET', 'OTHER']);
const uuid = z.string().uuid();
const text = (min: number, max: number) => z.string().trim().refine(v => {
  const n = Array.from(v).length;
  return n >= min && n <= max;
}, `Mətn ${min}–${max} simvol olmalıdır.`);
const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const lat = z.number().finite().min(-90).max(90);
const lon = z.number().finite().min(-180).max(180);
const paging = {
  page: z.string().regex(/^\d+$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) >= 1).optional(),
  pageSize: z.string().regex(/^\d+$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100).optional(),
};
const emptyQuery = z.object({}).strict();
const businessBody = z.object({
  name: text(2, 120), description: text(0, 2000).nullable(), category,
  address: text(5, 300), latitude: lat, longitude: lon, contactPhone: phone,
  imageFileId: z.null(),
}).strict();
const patchBody = z.object({
  name: text(2, 120).optional(), description: text(0, 2000).nullable().optional(), category: category.optional(),
  address: text(5, 300).optional(), latitude: lat.optional(), longitude: lon.optional(),
  contactPhone: phone.optional(), imageFileId: uuid.nullable().optional(),
}).strict().refine(v => Object.keys(v).length > 0, 'Ən azı bir sahə daxil edin.')
  .refine(v => (v.latitude === undefined) === (v.longitude === undefined), 'Koordinatlar birlikdə verilməlidir.');
const applyBody = z.object({ verificationInfo: text(10, 2000), documentFileIds: z.array(uuid).min(1).max(5) }).strict();
const publicFields = `b.id, b.name, b.description, b.category, b.address,
  b.latitude::float8 AS latitude, b.longitude::float8 AS longitude, b.contact_phone,
  b.image_file_id, b.created_at, b.updated_at`;
const managedFields = `${publicFields}, b.owner_id, b.verification_status,
  (SELECT a.id FROM public.business_applications a WHERE a.business_id = b.id
   ORDER BY a.submitted_at DESC, a.id ASC LIMIT 1) AS latest_application_id`;
const applicationFields = `a.id, a.business_id, a.status, a.verification_info, a.document_file_ids,
  a.submitted_at, a.reviewed_at, a.reviewed_by, a.decision_reason, a.business_snapshot`;
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Resurs tapılmadı.');
const validation = (message: string) => new HttpError(422, 'VALIDATION_ERROR', message);
const conflict = (message: string) => new HttpError(409, 'INVALID_TRANSITION', message);
function pagination(req: Parameters<typeof page>[0]) {
  const p = page(req);
  if (!Number.isSafeInteger(p.offset)) throw validation('Səhifə nömrəsi yanlışdır.');
  return p as { page: number; pageSize: number; offset: number };
}
async function lockActor(c: PoolClient, actorId: string, forUpdate = false) {
  // Role/status is rechecked under a lock because authentication may predate a suspension.
  const r = await c.query(`SELECT role, status FROM public.profiles WHERE id=$1 ${forUpdate ? 'FOR UPDATE' : 'FOR SHARE'}`, [actorId]);
  const profile = r.rows[0];
  if (!profile || profile.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Hesab aktiv deyil.');
  if (!['CUSTOMER', 'BUSINESS_OWNER'].includes(profile.role)) throw new HttpError(403, 'FORBIDDEN', 'Bu əməliyyat üçün icazəniz yoxdur.');
  return profile;
}
async function lockBusiness(c: PoolClient, businessId: string, actorId: string) {
  const r = await c.query('SELECT id, owner_id, verification_status, name, category, address, latitude::float8 AS latitude, longitude::float8 AS longitude, contact_phone FROM public.businesses WHERE id=$1 AND owner_id=$2 FOR UPDATE', [businessId, actorId]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}
async function assertUpload(c: PoolClient, businessId: string, fileId: string, purpose: string) {
  const r = await c.query('SELECT id FROM public.uploads WHERE id=$1 AND business_id=$2 AND purpose=$3 FOR SHARE', [fileId, businessId, purpose]);
  if (!r.rows[0]) throw validation('Fayl bu biznesə aid deyil və ya faylın təyinatı yanlışdır.');
}
async function managed(c: PoolClient, businessId: string, actorId: string) {
  const r = await c.query(`SELECT ${managedFields} FROM public.businesses b WHERE b.id=$1 AND b.owner_id=$2`, [businessId, actorId]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}

// /me must be registered ahead of /:id.
router.get('/businesses/me', requireAuth, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(z.object(paging).strict(), req.query);
  const p = pagination(req);
  const [count, data] = await Promise.all([
    pool.query('SELECT count(*) AS total FROM public.businesses b WHERE b.owner_id=$1', [req.actor!.id]),
    pool.query(`SELECT ${managedFields} FROM public.businesses b WHERE b.owner_id=$1 ORDER BY b.created_at DESC, b.id ASC LIMIT $2 OFFSET $3`, [req.actor!.id, p.pageSize, p.offset]),
  ]);
  return list(res, data.rows, count.rows[0].total, p.page, p.pageSize);
}));
router.get('/businesses', asyncHandler(async (req, res) => {
  const q = parse(z.object({ ...paging, q: text(1, 100).optional(), category: category.optional() }).strict(), req.query);
  const p = pagination(req);
  const where = `b.verification_status='APPROVED' AND owner.status='ACTIVE'
    AND ($1::text IS NULL OR strpos(lower(b.name), lower($1)) > 0)
    AND ($2::text IS NULL OR b.category::text=$2)`;
  const params = [q.q ?? null, q.category ?? null];
  const [count, data] = await Promise.all([
    pool.query(`SELECT count(*) AS total FROM public.businesses b JOIN public.profiles owner ON owner.id=b.owner_id WHERE ${where}`, params),
    pool.query(`SELECT ${publicFields} FROM public.businesses b JOIN public.profiles owner ON owner.id=b.owner_id WHERE ${where} ORDER BY b.name ASC, b.id ASC LIMIT $3 OFFSET $4`, [...params, p.pageSize, p.offset]),
  ]);
  return list(res, data.rows, count.rows[0].total, p.page, p.pageSize);
}));
router.post('/businesses', requireAuth, requireVerified, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const input = parse(businessBody, req.body);
  const result = await transaction(async c => {
    const actor = await lockActor(c, req.actor!.id, true);
    const r = await c.query(`INSERT INTO public.businesses
      (owner_id, name, description, category, address, latitude, longitude, contact_phone, image_file_id, verification_status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,'DRAFT') RETURNING id`,
      [req.actor!.id, input.name, input.description, input.category, input.address, input.latitude, input.longitude, input.contactPhone]);
    if (actor.role === 'CUSTOMER') await c.query("UPDATE public.profiles SET role='BUSINESS_OWNER', updated_at=clock_timestamp() WHERE id=$1", [req.actor!.id]);
    return managed(c, r.rows[0].id, req.actor!.id);
  });
  return ok(res, result, 201);
}));
router.get('/businesses/:id/manage', requireAuth, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const id = parse(uuid, req.params.id);
  const r = await pool.query(`SELECT ${managedFields} FROM public.businesses b WHERE b.id=$1 AND b.owner_id=$2`, [id, req.actor!.id]);
  if (!r.rows[0]) throw notFound();
  return ok(res, r.rows[0]);
}));
router.get('/businesses/:id/applications', requireAuth, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(z.object(paging).strict(), req.query);
  const id = parse(uuid, req.params.id);
  const p = pagination(req);
  const own = await pool.query('SELECT id FROM public.businesses WHERE id=$1 AND owner_id=$2', [id, req.actor!.id]);
  if (!own.rows[0]) throw notFound();
  const [count, data] = await Promise.all([
    pool.query('SELECT count(*) AS total FROM public.business_applications a WHERE a.business_id=$1', [id]),
    pool.query(`SELECT ${applicationFields} FROM public.business_applications a WHERE a.business_id=$1 ORDER BY a.submitted_at DESC, a.id ASC LIMIT $2 OFFSET $3`, [id, p.pageSize, p.offset]),
  ]);
  return list(res, data.rows, count.rows[0].total, p.page, p.pageSize);
}));
router.post('/businesses/:id/apply', requireAuth, requireVerified, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const id = parse(uuid, req.params.id);
  const input = parse(applyBody, req.body);
  const result = await transaction(async c => {
    await lockActor(c, req.actor!.id);
    const b = await lockBusiness(c, id, req.actor!.id);
    if (b.verification_status === 'PENDING') throw new HttpError(409, 'APPLICATION_ALREADY_PENDING', 'Müraciət artıq baxılmaqdadır.');
    if (!['DRAFT', 'REJECTED'].includes(b.verification_status)) throw conflict('Bu biznes üçün müraciət təqdim edilə bilməz.');
    // Lock referenced uploads so concurrent cleanup cannot remove them during linking.
    const uniqueIds = [...new Set(input.documentFileIds.map(v => v.toLowerCase()))];
    const files = await c.query("SELECT id FROM public.uploads WHERE id=ANY($1::uuid[]) AND business_id=$2 AND purpose='VERIFICATION_DOCUMENT' ORDER BY id FOR SHARE", [uniqueIds, id]);
    if (files.rowCount !== uniqueIds.length) throw validation('Sənədlər bu biznesə aid deyil və ya təyinatı yanlışdır.');
    const pending = await c.query("SELECT id FROM public.business_applications WHERE business_id=$1 AND status='PENDING'", [id]);
    if (pending.rows[0]) throw new HttpError(409, 'APPLICATION_ALREADY_PENDING', 'Müraciət artıq baxılmaqdadır.');
    const snapshot = { name: b.name, category: b.category, address: b.address, latitude: b.latitude, longitude: b.longitude, contactPhone: b.contact_phone };
    const created = await c.query(`INSERT INTO public.business_applications (business_id,status,verification_info,document_file_ids,business_snapshot)
      VALUES ($1,'PENDING',$2,$3::uuid[],$4::jsonb) RETURNING id`, [id, input.verificationInfo, input.documentFileIds, JSON.stringify(snapshot)]);
    await c.query("UPDATE public.businesses SET verification_status='PENDING', updated_at=clock_timestamp() WHERE id=$1", [id]);
    const app = await c.query(`SELECT ${applicationFields} FROM public.business_applications a WHERE a.id=$1`, [created.rows[0].id]);
    return app.rows[0];
  });
  return ok(res, result, 201);
}));
router.patch('/businesses/:id', requireAuth, requireVerified, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const id = parse(uuid, req.params.id);
  const input = parse(patchBody, req.body);
  const result = await transaction(async c => {
    await lockActor(c, req.actor!.id);
    const b = await lockBusiness(c, id, req.actor!.id);
    const restricted = ['name', 'category', 'address', 'latitude', 'longitude'];
    if (!['DRAFT', 'REJECTED'].includes(b.verification_status) && restricted.some(k => Object.prototype.hasOwnProperty.call(input, k))) {
      throw conflict('Bu sahələr yalnız qaralama və ya rədd edilmiş biznesdə dəyişə bilər.');
    }
    if (input.imageFileId) await assertUpload(c, id, input.imageFileId, 'BUSINESS_IMAGE');
    const columns: Record<string, string> = { name: 'name', description: 'description', category: 'category', address: 'address', latitude: 'latitude', longitude: 'longitude', contactPhone: 'contact_phone', imageFileId: 'image_file_id' };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${columns[key]}=$${values.length}`);
    }
    await c.query(`UPDATE public.businesses SET ${sets.join(', ')}, updated_at=clock_timestamp() WHERE id=$1`, values);
    return managed(c, id, req.actor!.id);
  });
  return ok(res, result);
}));
router.get('/businesses/:id', asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const id = parse(uuid, req.params.id);
  const r = await pool.query(`SELECT ${publicFields} FROM public.businesses b JOIN public.profiles owner ON owner.id=b.owner_id WHERE b.id=$1 AND b.verification_status='APPROVED' AND owner.status='ACTIVE'`, [id]);
  if (!r.rows[0]) throw notFound();
  return ok(res, r.rows[0]);
}));

export default router;
