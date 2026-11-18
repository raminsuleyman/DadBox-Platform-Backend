import { Router } from 'express';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from '../lib/db.js';
import { HttpError, asyncHandler, ok, list, parse, page } from '../lib/http.js';
import { requireAuth, requireVerified, requireRole } from '../middleware/auth.js';

const router = Router();
const uuid = z.string().uuid();
const emptyQuery = z.object({}).strict();
const paging = {
  page: z.string().regex(/^\d+$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) >= 1).optional(),
  pageSize: z.string().regex(/^\d+$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100).optional(),
};
const text = (min: number, max: number) => z.string().trim().refine(v => {
  const length = Array.from(v).length;
  return length >= min && length <= max;
}, `Mətn ${min}–${max} simvol olmalıdır.`);
const reviewBody = z.object({ reservationId: uuid, rating: z.number().int().min(1).max(5), comment: text(0, 1000).nullable() }).strict();
const targetType = z.enum(['BUSINESS', 'BOX', 'REVIEW', 'RESERVATION']);
const complaintStatus = z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED']);
const complaintBody = z.object({ targetType, targetId: uuid, description: text(10, 2000) }).strict();
const reviewFields = `r.id, r.business_id, r.reservation_id, p.full_name AS customer_display_name,
  r.rating, r.comment, r.status, r.created_at, r.updated_at`;
const complaintFields = `c.id, c.user_id, c.target_type, c.target_id, c.description, c.status,
  c.resolution, c.created_at, c.updated_at, c.resolved_at`;
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Resurs tapılmadı.');

function pagination(req: Request) {
  const p = page(req);
  if (!Number.isSafeInteger(p.offset)) throw new HttpError(422, 'VALIDATION_ERROR', 'Səhifə nömrəsi yanlışdır.');
  return p;
}

// Protect writes against a concurrent suspension or role change.
async function lockClient(c: PoolClient, actorId: string) {
  const row = (await c.query('SELECT role, status FROM public.profiles WHERE id=$1 FOR SHARE', [actorId])).rows[0];
  if (!row || row.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Hesab aktiv deyil.');
  if (!['CUSTOMER', 'BUSINESS_OWNER'].includes(row.role)) throw new HttpError(403, 'FORBIDDEN', 'Bu əməliyyat üçün icazəniz yoxdur.');
  return row;
}

// Access means the target can actually be read through a normal non-admin API.
// Lock each contributing row until the complaint is inserted; target IDs are never trusted on their own.
async function lockVisibleTarget(c: PoolClient, type: z.infer<typeof targetType>, id: string, actorId: string, role: string) {
  let sql: string;
  let params: unknown[];
  switch (type) {
    case 'RESERVATION':
      sql = 'SELECT r.id FROM public.reservations r WHERE r.id=$1 AND r.customer_id=$2 FOR SHARE OF r';
      params = [id, actorId];
      break;
    case 'BUSINESS':
      sql = `SELECT b.id FROM public.businesses b JOIN public.profiles owner ON owner.id=b.owner_id
        WHERE b.id=$1 AND ((b.verification_status='APPROVED' AND owner.status='ACTIVE')
          OR ($3::boolean AND b.owner_id=$2)) FOR SHARE OF b, owner`;
      params = [id, actorId, role === 'BUSINESS_OWNER'];
      break;
    case 'BOX':
      sql = `SELECT x.id FROM public.surprise_boxes x
        JOIN public.businesses b ON b.id=x.business_id JOIN public.profiles owner ON owner.id=b.owner_id
        WHERE x.id=$1 AND ((b.verification_status='APPROVED' AND owner.status='ACTIVE'
          AND x.status='ACTIVE' AND x.available_quantity>0 AND x.pickup_end>clock_timestamp())
          OR ($3::boolean AND b.owner_id=$2)) FOR SHARE OF x, b, owner`;
      params = [id, actorId, role === 'BUSINESS_OWNER'];
      break;
    case 'REVIEW':
      sql = `SELECT r.id FROM public.reviews r JOIN public.businesses b ON b.id=r.business_id
        JOIN public.profiles owner ON owner.id=b.owner_id WHERE r.id=$1 AND r.status='VISIBLE'
        AND b.verification_status='APPROVED' AND owner.status='ACTIVE' FOR SHARE OF r, b, owner`;
      params = [id];
      break;
  }
  if (!(await c.query(sql, params)).rows[0]) throw notFound();
}

router.post('/reviews', requireAuth, requireRole('CUSTOMER', 'BUSINESS_OWNER'), requireVerified, asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const input = parse(reviewBody, req.body);
  const actorId = req.actor!.id;
  const result = await transaction(async c => {
    await lockClient(c, actorId);
    const reservation = (await c.query(`SELECT id, business_id, status FROM public.reservations
      WHERE id=$1 AND customer_id=$2 FOR UPDATE`, [input.reservationId, actorId])).rows[0];
    if (!reservation) throw notFound();
    if (reservation.status !== 'PICKED_UP') throw new HttpError(409, 'INVALID_TRANSITION', 'Yalnız götürülmüş sifarişə rəy yazmaq olar.');
    if ((await c.query('SELECT id FROM public.reviews WHERE reservation_id=$1', [reservation.id])).rows[0]) {
      throw new HttpError(409, 'ALREADY_REVIEWED', 'Bu sifarişə artıq rəy yazılıb.');
    }
    let created;
    try {
      created = await c.query(`INSERT INTO public.reviews (reservation_id, customer_id, business_id, rating, comment, status)
        VALUES ($1,$2,$3,$4,$5,'VISIBLE') RETURNING id`, [reservation.id, actorId, reservation.business_id, input.rating, input.comment]);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new HttpError(409, 'ALREADY_REVIEWED', 'Bu sifarişə artıq rəy yazılıb.');
      }
      throw error;
    }
    return (await c.query(`SELECT ${reviewFields} FROM public.reviews r JOIN public.profiles p ON p.id=r.customer_id WHERE r.id=$1`, [created.rows[0].id])).rows[0];
  });
  return ok(res, result, 201);
}));

router.get('/businesses/:id/reviews', asyncHandler(async (req, res) => {
  parse(z.object(paging).strict(), req.query);
  const id = parse(uuid, req.params.id);
  const p = pagination(req);
  const result = await transaction(async c => {
    // Keep business visibility, count and page on the same snapshot.
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const visible = await c.query(`SELECT b.id FROM public.businesses b JOIN public.profiles owner ON owner.id=b.owner_id
      WHERE b.id=$1 AND b.verification_status='APPROVED' AND owner.status='ACTIVE'`, [id]);
    if (!visible.rows[0]) throw notFound();
    const count = await c.query("SELECT count(*) AS total FROM public.reviews r WHERE r.business_id=$1 AND r.status='VISIBLE'", [id]);
    const data = await c.query(`SELECT ${reviewFields} FROM public.reviews r JOIN public.profiles p ON p.id=r.customer_id
      WHERE r.business_id=$1 AND r.status='VISIBLE' ORDER BY r.created_at DESC, r.id ASC LIMIT $2 OFFSET $3`, [id, p.pageSize, p.offset]);
    return { total: count.rows[0].total, rows: data.rows };
  });
  return list(res, result.rows, result.total, p.page, p.pageSize);
}));

router.post('/complaints', requireAuth, requireRole('CUSTOMER', 'BUSINESS_OWNER'), requireVerified, asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const input = parse(complaintBody, req.body);
  const actorId = req.actor!.id;
  const result = await transaction(async c => {
    const actor = await lockClient(c, actorId);
    await lockVisibleTarget(c, input.targetType, input.targetId, actorId, actor.role);
    const created = await c.query(`INSERT INTO public.complaints (user_id, target_type, target_id, description, status, resolution, resolved_at)
      VALUES ($1,$2,$3,$4,'OPEN',NULL,NULL) RETURNING id`, [actorId, input.targetType, input.targetId, input.description]);
    return (await c.query(`SELECT ${complaintFields} FROM public.complaints c WHERE c.id=$1`, [created.rows[0].id])).rows[0];
  });
  return ok(res, result, 201);
}));

router.get('/complaints/me', requireAuth, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  const q = parse(z.object({ ...paging, status: complaintStatus.optional() }).strict(), req.query);
  const p = pagination(req);
  const params = [req.actor!.id, q.status ?? null];
  const where = 'c.user_id=$1 AND ($2::text IS NULL OR c.status::text=$2)';
  const result = await transaction(async c => {
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const count = await c.query(`SELECT count(*) AS total FROM public.complaints c WHERE ${where}`, params);
    const data = await c.query(`SELECT ${complaintFields} FROM public.complaints c WHERE ${where}
      ORDER BY c.created_at DESC, c.id ASC LIMIT $3 OFFSET $4`, [...params, p.pageSize, p.offset]);
    return { total: count.rows[0].total, rows: data.rows };
  });
  return list(res, result.rows, result.total, p.page, p.pageSize);
}));

router.get('/complaints/:id', requireAuth, requireRole('CUSTOMER', 'BUSINESS_OWNER'), asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const id = parse(uuid, req.params.id);
  const result = await pool.query(`SELECT ${complaintFields} FROM public.complaints c WHERE c.id=$1 AND c.user_id=$2`, [id, req.actor!.id]);
  if (!result.rows[0]) throw notFound();
  return ok(res, result.rows[0]);
}));

export default router;
