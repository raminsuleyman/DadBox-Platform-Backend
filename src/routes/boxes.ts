import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from '../lib/db.js';
import { HttpError, asyncHandler, ok, list, parse, page } from '../lib/http.js';
import { requireAuth, requireVerified, requireRole } from '../middleware/auth.js';

const router = Router();
const category = z.enum(['BAKERY', 'CAFE', 'RESTAURANT', 'SUPERMARKET', 'OTHER']);
const boxStatus = z.enum(['ACTIVE', 'DEACTIVATED', 'EXPIRED']);
const uuid = z.string().uuid();
const text = (min: number, max: number) => z.string().trim().refine(v => {
  const n = Array.from(v).length;
  return n >= min && n <= max;
}, `Mətn ${min}–${max} simvol olmalıdır.`);
const instant = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)), 'Tarix yanlışdır.');
const allergens = z.array(text(1, 80)).max(20).refine(a => new Set(a).size === a.length, 'Allergenlər unikal olmalıdır.');
const price = z.number().int().safe().min(1).max(100000000);
const paging = {
  page: z.string().regex(/^\d+$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) >= 1).optional(),
  pageSize: z.string().regex(/^\d+$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100).optional(),
};
const numericQuery = z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/).transform(Number).refine(Number.isFinite);
const integerQuery = z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger);
const emptyQuery = z.object({}).strict();
const fields = {
  title: text(2, 120), description: text(10, 2000), category,
  originalPriceMinor: price, discountedPriceMinor: price,
  availableQuantity: z.number().int().min(0).max(10000), pickupStart: instant, pickupEnd: instant,
  allergens, foodInfo: text(1, 1000), imageFileId: uuid,
};
const createBody = z.object({ ...fields, businessId: uuid, availableQuantity: z.number().int().min(1).max(10000) }).strict();
const patchBody = z.object(fields).partial().strict().refine(v => Object.keys(v).length > 0, 'Ən azı bir sahə daxil edin.');
const searchQuery = z.object({
  ...paging, q: text(1, 100).optional(), category: category.optional(),
  minPriceMinor: integerQuery.refine(v => v <= 100000000).optional(),
  maxPriceMinor: integerQuery.refine(v => v <= 100000000).optional(),
  lat: numericQuery.refine(v => v >= -90 && v <= 90).optional(),
  lon: numericQuery.refine(v => v >= -180 && v <= 180).optional(),
  radiusMeters: integerQuery.refine(v => v >= 1 && v <= 100000).optional(),
  pickupFrom: instant.optional(), pickupTo: instant.optional(),
  available: z.enum(['true', 'false']).optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'distance_asc']).optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.lat === undefined) !== (v.lon === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Koordinatlar birlikdə verilməlidir.', path: ['lat'] });
  if (v.radiusMeters !== undefined && (v.lat === undefined || v.lon === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Radius üçün koordinatlar tələb olunur.', path: ['radiusMeters'] });
  if (v.sort === 'distance_asc' && (v.lat === undefined || v.lon === undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Məsafəyə görə sıralama üçün koordinatlar tələb olunur.', path: ['sort'] });
  if (v.minPriceMinor !== undefined && v.maxPriceMinor !== undefined && v.minPriceMinor > v.maxPriceMinor) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Minimum qiymət maksimum qiymətdən böyük ola bilməz.', path: ['minPriceMinor'] });
  if (v.pickupFrom !== undefined && v.pickupTo !== undefined && Date.parse(v.pickupFrom) >= Date.parse(v.pickupTo)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Başlanğıc son tarixdən əvvəl olmalıdır.', path: ['pickupFrom'] });
});
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Resurs tapılmadı.');
const validation = (message: string) => new HttpError(422, 'VALIDATION_ERROR', message);
const conflict = (message: string) => new HttpError(409, 'INVALID_TRANSITION', message);
function pagination(req: Parameters<typeof page>[0]) {
  const p = page(req);
  if (!Number.isSafeInteger(p.offset)) throw validation('Səhifə nömrəsi yanlışdır.');
  return p as { page: number; pageSize: number; offset: number };
}
// The public and management variants deliberately select only documented fields.
const effectiveStatus = `CASE WHEN box.status::text='ACTIVE' AND box.pickup_end<=clock_timestamp() THEN 'EXPIRED' ELSE box.status::text END`;
const boxFields = `box.id, box.business_id, b.name AS business_name, box.title, box.description, box.category,
  box.original_price_minor::integer AS original_price_minor, box.discounted_price_minor::integer AS discounted_price_minor,
  'AZN'::text AS currency, box.available_quantity, box.pickup_start, box.pickup_end, box.pickup_end AS expires_at,
  box.allergens, box.food_info, box.image_file_id, ${effectiveStatus} AS status, box.created_at, box.updated_at`;
const projected = `id, business_id, business_name, title, description, category, original_price_minor,
  discounted_price_minor, currency, available_quantity, pickup_start, pickup_end, expires_at, allergens,
  food_info, image_file_id, status, created_at, updated_at`;

async function lockActor(c: PoolClient, id: string) {
  const r = await c.query('SELECT role,status FROM public.profiles WHERE id=$1 FOR SHARE', [id]);
  if (!r.rows[0] || r.rows[0].status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Hesab aktiv deyil.');
  if (!['CUSTOMER', 'BUSINESS_OWNER'].includes(r.rows[0].role)) throw new HttpError(403, 'FORBIDDEN', 'Bu əməliyyat üçün icazəniz yoxdur.');
}
async function lockBusiness(c: PoolClient, businessId: string, actorId: string) {
  const r = await c.query('SELECT id,owner_id,verification_status FROM public.businesses WHERE id=$1 AND owner_id=$2 FOR UPDATE', [businessId, actorId]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}
async function assertBoxImage(c: PoolClient, businessId: string, imageId: string) {
  const r = await c.query("SELECT id FROM public.uploads WHERE id=$1 AND business_id=$2 AND purpose='BOX_IMAGE' FOR SHARE", [imageId, businessId]);
  if (!r.rows[0]) throw validation('Şəkil bu biznesə aid deyil və ya təyinatı yanlışdır.');
}
async function getManagedBox(c: PoolClient, id: string, actorId: string) {
  const r = await c.query(`SELECT ${boxFields}, box.moderation_reason, NULL::integer AS distance_meters
    FROM public.surprise_boxes box JOIN public.businesses b ON b.id=box.business_id WHERE box.id=$1 AND b.owner_id=$2`, [id, actorId]);
  if (!r.rows[0]) throw notFound();
  return r.rows[0];
}
// Call only after locking the actor. Resolve links without locks, then recheck after
// locking business followed by box. Those links are immutable in the MVP.
async function lockOwnedBox(c: PoolClient, boxId: string, actorId: string) {
  const initial = await c.query('SELECT business_id FROM public.surprise_boxes WHERE id=$1', [boxId]);
  if (!initial.rows[0]) throw notFound();
  const business = await lockBusiness(c, initial.rows[0].business_id, actorId);
  const found = await c.query('SELECT * FROM public.surprise_boxes WHERE id=$1 AND business_id=$2 FOR UPDATE', [boxId, business.id]);
  if (!found.rows[0]) throw notFound();
  return { business, box: found.rows[0] };
}
function validateState(state: { originalPriceMinor: number; discountedPriceMinor: number; pickupStart: string | Date; pickupEnd: string | Date }, now: Date) {
  if (state.discountedPriceMinor < 1 || state.originalPriceMinor > 100000000 || state.discountedPriceMinor >= state.originalPriceMinor) {
    throw validation('Endirimli qiymət ilkin qiymətdən kiçik olmalıdır.');
  }
  const start = new Date(state.pickupStart).getTime();
  const end = new Date(state.pickupEnd).getTime();
  const current = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end <= current || end - start > 24 * 60 * 60 * 1000 || end > current + 30 * 24 * 60 * 60 * 1000) {
    throw validation('Götürmə intervalı yanlışdır və ya icazə verilən müddətdən kənardadır.');
  }
}

router.get('/boxes', asyncHandler(async (req, res) => {
  // parse's shared signature uses identical input/output types; this query schema
  // intentionally converts validated numeric query strings into numbers.
  const q = parse(searchQuery as unknown as z.ZodType<z.output<typeof searchQuery>>, req.query);
  const p = pagination(req);
  if (q.available === 'false') return list(res, [], 0, p.page, p.pageSize);
  const params = [q.q ?? null, q.category ?? null, q.minPriceMinor ?? null, q.maxPriceMinor ?? null,
    q.pickupFrom ?? null, q.pickupTo ?? null, q.lat ?? null, q.lon ?? null, q.radiusMeters ?? null];
  // Clamp the Haversine intermediate against floating-point drift at antipodal points.
  const distance = `CASE WHEN $7::float8 IS NULL THEN NULL ELSE 2.0*6371000.0*asin(sqrt(least(1.0,greatest(0.0,
    power(sin(radians(b.latitude::float8-$7::float8)/2.0),2.0) + cos(radians($7::float8))*cos(radians(b.latitude::float8))*power(sin(radians(b.longitude::float8-$8::float8)/2.0),2.0)
  )))) END`;
  const cte = `WITH filtered AS (
    SELECT ${boxFields}, ${distance} AS distance_raw
    FROM public.surprise_boxes box JOIN public.businesses b ON b.id=box.business_id
    JOIN public.profiles owner ON owner.id=b.owner_id
    WHERE box.status='ACTIVE' AND box.available_quantity>0 AND box.pickup_end>clock_timestamp()
      AND b.verification_status='APPROVED' AND owner.status='ACTIVE'
      AND ($1::text IS NULL OR strpos(lower(box.title),lower($1))>0 OR strpos(lower(b.name),lower($1))>0)
      AND ($2::text IS NULL OR box.category::text=$2)
      AND ($3::bigint IS NULL OR box.discounted_price_minor >= $3)
      AND ($4::bigint IS NULL OR box.discounted_price_minor <= $4)
      AND ($5::timestamptz IS NULL OR box.pickup_end > $5)
      AND ($6::timestamptz IS NULL OR box.pickup_start < $6)
  )`;
  const order = { newest: 'created_at DESC', price_asc: 'discounted_price_minor ASC', price_desc: 'discounted_price_minor DESC', distance_asc: 'distance_raw ASC' }[q.sort ?? 'newest'];
  const where = '($9::float8 IS NULL OR distance_raw <= $9::float8)';
  const [count, data] = await Promise.all([
    pool.query(`${cte} SELECT count(*) AS total FROM filtered WHERE ${where}`, params),
    pool.query(`${cte} SELECT ${projected}, round(distance_raw)::integer AS distance_meters FROM filtered WHERE ${where} ORDER BY ${order}, id ASC LIMIT $10 OFFSET $11`, [...params, p.pageSize, p.offset]),
  ]);
  return list(res, data.rows, count.rows[0].total, p.page, p.pageSize);
}));
router.get('/boxes/:id', asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const id = parse(uuid, req.params.id);
  const r = await pool.query(`SELECT ${boxFields}, NULL::integer AS distance_meters FROM public.surprise_boxes box
    JOIN public.businesses b ON b.id=box.business_id JOIN public.profiles owner ON owner.id=b.owner_id
    WHERE box.id=$1 AND box.status='ACTIVE' AND box.available_quantity>0 AND box.pickup_end>clock_timestamp()
      AND b.verification_status='APPROVED' AND owner.status='ACTIVE'`, [id]);
  if (!r.rows[0]) throw notFound();
  return ok(res, r.rows[0]);
}));
router.get('/businesses/:id/boxes', requireAuth, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  const q = parse(z.object({ ...paging, status: boxStatus.optional() }).strict(), req.query);
  const id = parse(uuid, req.params.id);
  const p = pagination(req);
  const own = await pool.query('SELECT id FROM public.businesses WHERE id=$1 AND owner_id=$2', [id, req.actor!.id]);
  if (!own.rows[0]) throw notFound();
  const where = `box.business_id=$1 AND ($2::text IS NULL OR (${effectiveStatus})=$2)`;
  const [count, data] = await Promise.all([
    pool.query(`SELECT count(*) AS total FROM public.surprise_boxes box WHERE ${where}`, [id, q.status ?? null]),
    pool.query(`SELECT ${boxFields}, box.moderation_reason, NULL::integer AS distance_meters FROM public.surprise_boxes box
      JOIN public.businesses b ON b.id=box.business_id WHERE ${where} ORDER BY box.created_at DESC,box.id ASC LIMIT $3 OFFSET $4`, [id, q.status ?? null, p.pageSize, p.offset]),
  ]);
  return list(res, data.rows, count.rows[0].total, p.page, p.pageSize);
}));
router.post('/boxes', requireAuth, requireVerified, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const input = parse(createBody, req.body);
  const result = await transaction(async c => {
    await lockActor(c, req.actor!.id);
    const business = await lockBusiness(c, input.businessId, req.actor!.id);
    if (business.verification_status !== 'APPROVED') throw conflict('Biznes təsdiqlənməyib.');
    await assertBoxImage(c, input.businessId, input.imageFileId);
    const time = await c.query('SELECT clock_timestamp() AS now');
    validateState(input, time.rows[0].now);
    const r = await c.query(`INSERT INTO public.surprise_boxes
      (business_id,title,description,category,original_price_minor,discounted_price_minor,available_quantity,pickup_start,pickup_end,allergens,food_info,image_file_id,status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::text[],$11,$12,'ACTIVE') RETURNING id`,
      [input.businessId, input.title, input.description, input.category, input.originalPriceMinor, input.discountedPriceMinor,
        input.availableQuantity, input.pickupStart, input.pickupEnd, input.allergens, input.foodInfo, input.imageFileId]);
    return getManagedBox(c, r.rows[0].id, req.actor!.id);
  });
  return ok(res, result, 201);
}));
router.patch('/boxes/:id', requireAuth, requireVerified, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const id = parse(uuid, req.params.id);
  const input = parse(patchBody, req.body);
  const result = await transaction(async c => {
    await lockActor(c, req.actor!.id);
    const { business, box } = await lockOwnedBox(c, id, req.actor!.id);
    const time = await c.query('SELECT clock_timestamp() AS now');
    if (business.verification_status !== 'APPROVED' || box.status !== 'ACTIVE' || new Date(box.pickup_end).getTime() <= time.rows[0].now.getTime()) throw conflict('Təklif dəyişdirilə bilməz.');
    const history = await c.query('SELECT EXISTS(SELECT 1 FROM public.reservations WHERE surprise_box_id=$1) AS has_history', [id]);
    if (history.rows[0].has_history && Object.keys(input).some(k => k !== 'availableQuantity' && k !== 'imageFileId')) throw conflict('Rezervasiya tarixçəsi olan təklifin kommersiya və götürmə məlumatları dəyişdirilə bilməz.');
    if (input.imageFileId !== undefined) await assertBoxImage(c, business.id, input.imageFileId);
    // Evaluate the resulting whole offer and use a fresh post-lock DB clock.
    const current = await c.query('SELECT clock_timestamp() AS now');
    validateState({ originalPriceMinor: input.originalPriceMinor ?? Number(box.original_price_minor), discountedPriceMinor: input.discountedPriceMinor ?? Number(box.discounted_price_minor), pickupStart: input.pickupStart ?? box.pickup_start, pickupEnd: input.pickupEnd ?? box.pickup_end }, current.rows[0].now);
    const columns: Record<string, string> = { title: 'title', description: 'description', category: 'category', originalPriceMinor: 'original_price_minor', discountedPriceMinor: 'discounted_price_minor', availableQuantity: 'available_quantity', pickupStart: 'pickup_start', pickupEnd: 'pickup_end', allergens: 'allergens', foodInfo: 'food_info', imageFileId: 'image_file_id' };
    const values: unknown[] = [id];
    const sets: string[] = [];
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${columns[key]}=$${values.length}`);
    }
    await c.query(`UPDATE public.surprise_boxes SET ${sets.join(', ')}, updated_at=clock_timestamp() WHERE id=$1`, values);
    return getManagedBox(c, id, req.actor!.id);
  });
  return ok(res, result);
}));
router.delete('/boxes/:id', requireAuth, requireVerified, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  parse(z.object({}).strict(), req.body ?? {});
  const id = parse(uuid, req.params.id);
  const result = await transaction(async c => {
    await lockActor(c, req.actor!.id);
    const { box } = await lockOwnedBox(c, id, req.actor!.id);
    const time = await c.query('SELECT clock_timestamp() AS now');
    if (box.status !== 'ACTIVE' || new Date(box.pickup_end).getTime() <= time.rows[0].now.getTime()) throw conflict('Təklif artıq deaktivdir və ya vaxtı bitib.');
    await c.query("UPDATE public.surprise_boxes SET status='DEACTIVATED',updated_at=clock_timestamp() WHERE id=$1", [id]);
    return getManagedBox(c, id, req.actor!.id);
  });
  return ok(res, result);
}));

export default router;
