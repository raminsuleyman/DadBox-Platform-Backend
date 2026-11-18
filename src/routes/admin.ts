import { Router } from 'express';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool, transaction } from '../lib/db.js';
import { HttpError, asyncHandler, ok, list, parse, page } from '../lib/http.js';
import { requireAuth, requireVerified, requireRole } from '../middleware/auth.js';

const router = Router();
const uuid = z.string().uuid();
const text = (min: number, max: number) => z.string().trim().refine(
  value => [...value].length >= min && [...value].length <= max,
  `Mətn ${min}–${max} simvol olmalıdır.`,
);
const reason = text(5, 500);
const pageField = z.string().regex(/^\d+$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) >= 1).optional();
const sizeField = z.string().regex(/^\d+$/).refine(v => Number.isSafeInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 100).optional();
const pagination = { page: pageField, pageSize: sizeField };
const emptyQuery = z.object({}).strict();
const roles = z.enum(['CUSTOMER', 'BUSINESS_OWNER', 'ADMIN']);
const accountStatuses = z.enum(['ACTIVE', 'SUSPENDED']);
const businessStatuses = z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED']);
const boxStatuses = z.enum(['ACTIVE', 'DEACTIVATED', 'EXPIRED']);
const reviewStatuses = z.enum(['VISIBLE', 'HIDDEN']);
const complaintStatuses = z.enum(['OPEN', 'IN_REVIEW', 'RESOLVED', 'DISMISSED']);
const complaintTargets = z.enum(['BUSINESS', 'BOX', 'REVIEW', 'RESERVATION']);
const queryUsers = z.object({ ...pagination, q: text(1, 100).optional(), role: roles.optional(), status: accountStatuses.optional() }).strict();
const queryBusinesses = z.object({ ...pagination, q: text(1, 100).optional(), status: businessStatuses.optional() }).strict();
const queryBoxes = z.object({ ...pagination, q: text(1, 100).optional(), status: boxStatuses.optional(), businessId: uuid.optional() }).strict();
const queryReviews = z.object({ ...pagination, status: reviewStatuses.optional(), businessId: uuid.optional() }).strict();
const queryComplaints = z.object({ ...pagination, status: complaintStatuses.optional(), targetType: complaintTargets.optional() }).strict();
const queryAudit = z.object({ ...pagination, actorId: uuid.optional(), targetType: text(1, 100).optional() }).strict();
const timeRange = z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional() }).strict().superRefine((v, ctx) => {
  if ((v.from === undefined) !== (v.to === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'from və to birlikdə verilməlidir.' });
  } else if (v.from !== undefined && v.to !== undefined) {
    const start = Date.parse(v.from), end = Date.parse(v.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 366 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Tarix intervalı düzgün və ən çox 366 gün olmalıdır.' });
    }
  }
});
const reasonBody = z.object({ reason }).strict();
const decisionBody = z.object({ applicationId: uuid, reason: reason.nullable() }).strict();
const rejectionBody = z.object({ applicationId: uuid, reason }).strict();
const moderateBody = z.object({ status: reviewStatuses, reason }).strict();
const complaintBody = z.object({ status: z.enum(['IN_REVIEW', 'RESOLVED', 'DISMISSED']), resolution: reason.nullable() }).strict().superRefine((value, ctx) => {
  if ((value.status === 'IN_REVIEW') !== (value.resolution === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resolution'], message: 'Baxılan şikayətdə null, yekun qərarda səbəb tələb olunur.' });
  }
});

function notFound(): never { throw new HttpError(404, 'NOT_FOUND', 'Resurs tapılmadı.'); }
function invalidTransition(): never { throw new HttpError(409, 'INVALID_TRANSITION', 'Bu status dəyişikliyi mümkün deyil.'); }
function actorId(req: Request): string {
  if (!req.actor) throw new HttpError(401, 'UNAUTHENTICATED', 'Daxil olun.');
  return req.actor.id;
}
function pathId(value: unknown): string { return parse(uuid, value); }
function noQuery(req: Request): void { parse(emptyQuery, req.query); }
function paginationFor(req: Request) {
  const p = page(req);
  if (!Number.isSafeInteger(p.offset)) throw new HttpError(422, 'VALIDATION_ERROR', 'Səhifə nömrəsi çox böyükdür.');
  return p;
}
function rangeFor(req: Request) {
  const input = parse(timeRange, req.query);
  const end = input.to === undefined ? new Date() : new Date(input.to);
  const start = input.from === undefined ? new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000) : new Date(input.from);
  return { from: start.toISOString(), to: end.toISOString() };
}
function safeInteger(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error('Unsafe integer in dashboard');
  return n;
}
function addFilter(conditions: string[], values: unknown[], expression: (param: string) => string, value: unknown) {
  if (value === undefined) return;
  values.push(value);
  conditions.push(expression(`$${values.length}`));
}

// The CTE yields one count row even for an empty or out-of-range page. The count
// and page are taken from the same PostgreSQL statement snapshot.
async function sendPage(res: Response, req: Request, selection: string, from: string, conditions: string[], values: unknown[]) {
  const p = paginationFor(req);
  const params = [...values, p.pageSize, p.offset];
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(`
    WITH filtered AS (SELECT ${selection} ${from} ${where}),
    counted AS (SELECT COUNT(*)::text AS total FROM filtered),
    paged AS (SELECT * FROM filtered ORDER BY created_at DESC, id ASC LIMIT $${values.length + 1} OFFSET $${values.length + 2})
    SELECT counted.total AS _list_total, paged.* FROM counted LEFT JOIN paged ON TRUE
    ORDER BY paged.created_at DESC, paged.id ASC`, params);
  const total = safeInteger(result.rows[0]._list_total);
  const rows = result.rows.filter(row => row.id !== null).map(({ _list_total, ...row }) => row);
  return list(res, rows, total, p.page, p.pageSize);
}

const profileFields = `p.id, u.email, (u.email_confirmed_at IS NOT NULL) AS email_verified,
  p.full_name, p.phone, p.role, p.status, p.created_at, p.updated_at`;
const businessFields = `b.id, b.name, b.description, b.category, b.address, b.latitude, b.longitude,
  b.contact_phone, b.image_file_id, b.owner_id, b.verification_status, b.created_at, b.updated_at,
  (SELECT a.id FROM public.business_applications a WHERE a.business_id=b.id ORDER BY a.submitted_at DESC, a.id ASC LIMIT 1) AS latest_application_id`;
const applicationFields = `a.id, a.business_id, a.status, a.verification_info, a.document_file_ids,
  a.submitted_at, a.reviewed_at, a.reviewed_by, a.decision_reason, a.business_snapshot`;
const effectiveBoxStatus = `(CASE WHEN box.status='ACTIVE' AND box.pickup_end <= statement_timestamp() THEN 'EXPIRED' ELSE box.status END)`;
const boxFields = `box.id, box.business_id, b.name AS business_name, box.title, box.description, box.category,
  box.original_price_minor, box.discounted_price_minor, 'AZN'::text AS currency, box.available_quantity,
  box.pickup_start, box.pickup_end, box.pickup_end AS expires_at, box.allergens, box.food_info, box.image_file_id,
  ${effectiveBoxStatus} AS status, box.created_at, box.updated_at, NULL::integer AS distance_meters, box.moderation_reason`;
const reviewFields = `r.id, r.business_id, r.reservation_id, p.full_name AS customer_display_name,
  r.rating, r.comment, r.status, r.created_at, r.updated_at`;
const complaintFields = `c.id, c.user_id, c.target_type, c.target_id, c.description, c.status,
  c.resolution, c.created_at, c.updated_at, c.resolved_at`;
const auditFields = `a.id, a.actor_id, a.action, a.target_type, a.target_id, a.reason, a.created_at`;

// Restrict the JSON snapshot to the six documented, immutable fields even if
// extra properties accidentally find their way into storage.
function applicationDto(row: Record<string, any>) {
  const s = row.business_snapshot ?? {};
  return { ...row, business_snapshot: {
    name: s.name, category: s.category, address: s.address,
    latitude: Number(s.latitude), longitude: Number(s.longitude),
    contactPhone: s.contactPhone ?? s.contact_phone,
  } };
}
async function fetchBusiness(client: PoolClient, id: string) {
  const result = await client.query(`SELECT ${businessFields} FROM public.businesses b WHERE b.id=$1`, [id]);
  if (!result.rows[0]) return notFound();
  return result.rows[0];
}
async function fetchApplication(client: PoolClient, id: string) {
  const result = await client.query(`SELECT ${applicationFields} FROM public.business_applications a WHERE a.id=$1`, [id]);
  if (!result.rows[0]) return notFound();
  return applicationDto(result.rows[0]);
}
async function fetchProfile(client: PoolClient, id: string) {
  const result = await client.query(`SELECT ${profileFields} FROM public.profiles p JOIN auth.users u ON u.id=p.id WHERE p.id=$1`, [id]);
  if (!result.rows[0]) return notFound();
  return result.rows[0];
}
async function audit(client: PoolClient, actor: string, action: string, type: string, id: string, why: string | null) {
  await client.query(`INSERT INTO public.audit_logs (actor_id, action, target_type, target_id, reason) VALUES ($1,$2,$3,$4,$5)`, [actor, action, type, id, why]);
}
// Profile locks precede all resource locks. Admin-user changes lock both
// affected profiles in UUID order so concurrent admin actions cannot race.
async function lockAdmin(client: PoolClient, actor: string) {
  const result = await client.query(`SELECT role,status FROM public.profiles WHERE id=$1 FOR SHARE`, [actor]);
  const profile = result.rows[0];
  if (!profile || profile.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Hesab bloklanıb.');
  if (profile.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Bu əməliyyat üçün icazəniz yoxdur.');
}

// The business dashboard is owner-scoped, including for ADMIN actors.
router.get('/businesses/:id/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const id = pathId(req.params.id), actor = actorId(req), { from, to } = rangeFor(req);
  const result = await pool.query(`
    SELECT b.id AS business_id,
      (SELECT COUNT(*)::text FROM public.surprise_boxes box JOIN public.profiles owner ON owner.id=b.owner_id
       WHERE box.business_id=b.id AND b.verification_status='APPROVED' AND owner.status='ACTIVE'
         AND box.status='ACTIVE' AND box.available_quantity>0 AND box.pickup_end>statement_timestamp()) AS active_offers,
      (SELECT COALESCE(SUM(box.available_quantity),0)::text FROM public.surprise_boxes box JOIN public.profiles owner ON owner.id=b.owner_id
       WHERE box.business_id=b.id AND b.verification_status='APPROVED' AND owner.status='ACTIVE'
         AND box.status='ACTIVE' AND box.available_quantity>0 AND box.pickup_end>statement_timestamp()) AS available_quantity,
      (SELECT COUNT(*)::text FROM public.reservations r WHERE r.business_id=b.id AND r.created_at >= $1::timestamptz AND r.created_at < $2::timestamptz) AS reservations_created,
      (SELECT COUNT(*)::text FROM public.reservations r WHERE r.business_id=b.id AND r.picked_up_at >= $1::timestamptz AND r.picked_up_at < $2::timestamptz) AS completed_pickups,
      (SELECT COALESCE(SUM(r.quantity),0)::text FROM public.reservations r WHERE r.business_id=b.id AND r.picked_up_at >= $1::timestamptz AND r.picked_up_at < $2::timestamptz) AS picked_up_boxes,
      (SELECT COALESCE(SUM(r.total_price_minor),0)::text FROM public.reservations r WHERE r.business_id=b.id AND r.picked_up_at >= $1::timestamptz AND r.picked_up_at < $2::timestamptz) AS estimated_pickup_value_minor
    FROM public.businesses b WHERE b.id=$3 AND b.owner_id=$4`, [from, to, id, actor]);
  const row = result.rows[0];
  if (!row) return notFound();
  return ok(res, { businessId: row.business_id, from, to, activeOffers: safeInteger(row.active_offers), availableQuantity: safeInteger(row.available_quantity), reservationsCreated: safeInteger(row.reservations_created), completedPickups: safeInteger(row.completed_pickups), pickedUpBoxes: safeInteger(row.picked_up_boxes), estimatedPickupValueMinor: safeInteger(row.estimated_pickup_value_minor), currency: 'AZN' });
}));

// All admin routes are authenticated active admins; writes additionally require
// a currently verified email, with the database actor rechecked under lock.
router.use('/admin', requireAuth, requireRole('ADMIN'));
router.use('/admin', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return requireVerified(req, res, next);
});

router.get('/admin/dashboard', asyncHandler(async (req, res) => {
  const { from, to } = rangeFor(req);
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::text FROM public.profiles) AS registered_users,
      (SELECT COUNT(*)::text FROM public.businesses b JOIN public.profiles p ON p.id=b.owner_id WHERE b.verification_status='APPROVED' AND p.status='ACTIVE') AS approved_businesses,
      (SELECT COUNT(*)::text FROM public.surprise_boxes box JOIN public.businesses b ON b.id=box.business_id JOIN public.profiles p ON p.id=b.owner_id WHERE box.status='ACTIVE' AND box.available_quantity>0 AND box.pickup_end>statement_timestamp() AND b.verification_status='APPROVED' AND p.status='ACTIVE') AS active_offers,
      (SELECT COALESCE(SUM(box.available_quantity),0)::text FROM public.surprise_boxes box JOIN public.businesses b ON b.id=box.business_id JOIN public.profiles p ON p.id=b.owner_id WHERE box.status='ACTIVE' AND box.available_quantity>0 AND box.pickup_end>statement_timestamp() AND b.verification_status='APPROVED' AND p.status='ACTIVE') AS available_quantity,
      (SELECT COUNT(*)::text FROM public.business_applications WHERE status='PENDING') AS pending_applications,
      (SELECT COUNT(*)::text FROM public.complaints WHERE status IN ('OPEN','IN_REVIEW')) AS open_complaints,
      (SELECT COUNT(*)::text FROM public.reservations WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz) AS reservations_created,
      (SELECT COUNT(*)::text FROM public.reservations WHERE picked_up_at >= $1::timestamptz AND picked_up_at < $2::timestamptz) AS completed_pickups,
      (SELECT COALESCE(SUM(quantity),0)::text FROM public.reservations WHERE picked_up_at >= $1::timestamptz AND picked_up_at < $2::timestamptz) AS picked_up_boxes,
      (SELECT COALESCE(SUM(total_price_minor),0)::text FROM public.reservations WHERE picked_up_at >= $1::timestamptz AND picked_up_at < $2::timestamptz) AS estimated_pickup_value_minor`, [from, to]);
  const r = result.rows[0];
  return ok(res, { from, to, registeredUsers: safeInteger(r.registered_users), approvedBusinesses: safeInteger(r.approved_businesses), activeOffers: safeInteger(r.active_offers), availableQuantity: safeInteger(r.available_quantity), pendingApplications: safeInteger(r.pending_applications), openComplaints: safeInteger(r.open_complaints), reservationsCreated: safeInteger(r.reservations_created), completedPickups: safeInteger(r.completed_pickups), pickedUpBoxes: safeInteger(r.picked_up_boxes), estimatedPickupValueMinor: safeInteger(r.estimated_pickup_value_minor), currency: 'AZN' });
}));

router.get('/admin/users', asyncHandler(async (req, res) => {
  const q = parse(queryUsers, req.query), conditions: string[] = [], values: unknown[] = [];
  addFilter(conditions, values, p => `(position(lower(${p}) in lower(p.full_name)) > 0 OR position(lower(${p}) in lower(u.email)) > 0)`, q.q);
  addFilter(conditions, values, p => `p.role=${p}`, q.role);
  addFilter(conditions, values, p => `p.status=${p}`, q.status);
  return sendPage(res, req, profileFields, 'FROM public.profiles p JOIN auth.users u ON u.id=p.id', conditions, values);
}));

async function changeUser(req: Request, res: Response, suspend: boolean) {
  noQuery(req);
  const target = pathId(req.params.id), actor = actorId(req), input = parse(reasonBody, req.body);
  const result = await transaction(async client => {
    const locks = await client.query(`SELECT id,role,status FROM public.profiles WHERE id = ANY($1::uuid[]) ORDER BY id ASC FOR UPDATE`, [[actor, target]]);
    const admin = locks.rows.find(r => r.id === actor), user = locks.rows.find(r => r.id === target);
    if (!admin || admin.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Hesab bloklanıb.');
    if (admin.role !== 'ADMIN') throw new HttpError(403, 'FORBIDDEN', 'Bu əməliyyat üçün icazəniz yoxdur.');
    if (!user) return notFound();
    if (suspend && actor === target) throw new HttpError(403, 'FORBIDDEN', 'Öz hesabınızı bloklaya bilməzsiniz.');
    if (user.status !== (suspend ? 'ACTIVE' : 'SUSPENDED')) return invalidTransition();
    if (suspend && user.role === 'ADMIN') {
      const count = await client.query(`SELECT COUNT(*)::text AS total FROM public.profiles WHERE role='ADMIN' AND status='ACTIVE'`);
      if (safeInteger(count.rows[0].total) <= 1) throw new HttpError(409, 'INVALID_TRANSITION', 'Son aktiv admin bloklana bilməz.');
    }
    await client.query(`UPDATE public.profiles SET status=$2,updated_at=clock_timestamp() WHERE id=$1`, [target, suspend ? 'SUSPENDED' : 'ACTIVE']);
    await audit(client, actor, suspend ? 'USER_SUSPEND' : 'USER_REACTIVATE', 'USER', target, input.reason);
    return fetchProfile(client, target);
  });
  return ok(res, result);
}
router.patch('/admin/users/:id/suspend', asyncHandler((req, res) => changeUser(req, res, true)));
router.patch('/admin/users/:id/reactivate', asyncHandler((req, res) => changeUser(req, res, false)));

router.get('/admin/businesses', asyncHandler(async (req, res) => {
  const q = parse(queryBusinesses, req.query), conditions: string[] = [], values: unknown[] = [];
  addFilter(conditions, values, p => `b.verification_status=${p}`, q.status);
  addFilter(conditions, values, p => `position(lower(${p}) in lower(b.name)) > 0`, q.q);
  return sendPage(res, req, businessFields, 'FROM public.businesses b', conditions, values);
}));
router.get('/admin/business-applications/:applicationId', asyncHandler(async (req, res) => {
  noQuery(req);
  const id = pathId(req.params.applicationId);
  const result = await pool.query(`SELECT ${applicationFields} FROM public.business_applications a WHERE a.id=$1`, [id]);
  if (!result.rows[0]) return notFound();
  return ok(res, applicationDto(result.rows[0]));
}));

async function decideApplication(req: Request, res: Response, approve: boolean) {
  noQuery(req);
  const id = pathId(req.params.id), actor = actorId(req);
  const input = approve ? parse(decisionBody, req.body) : parse(rejectionBody, req.body);
  const result = await transaction(async client => {
    await lockAdmin(client, actor);
    const business = await client.query(`SELECT id,verification_status FROM public.businesses WHERE id=$1 FOR UPDATE`, [id]);
    if (!business.rows[0]) return notFound();
    const latest = await client.query(`SELECT id,status FROM public.business_applications WHERE business_id=$1 ORDER BY submitted_at DESC,id ASC LIMIT 1 FOR UPDATE`, [id]);
    if (business.rows[0].verification_status !== 'PENDING' || !latest.rows[0] || latest.rows[0].id !== input.applicationId || latest.rows[0].status !== 'PENDING') return invalidTransition();
    const status = approve ? 'APPROVED' : 'REJECTED';
    await client.query(`UPDATE public.businesses SET verification_status=$2,updated_at=clock_timestamp() WHERE id=$1`, [id, status]);
    await client.query(`UPDATE public.business_applications SET status=$2,reviewed_at=clock_timestamp(),reviewed_by=$3,decision_reason=$4 WHERE id=$1`, [input.applicationId, status, actor, input.reason]);
    await audit(client, actor, approve ? 'BUSINESS_APPROVE' : 'BUSINESS_REJECT', 'BUSINESS', id, input.reason);
    return fetchApplication(client, input.applicationId);
  });
  return ok(res, result);
}
router.patch('/admin/businesses/:id/approve', asyncHandler((req, res) => decideApplication(req, res, true)));
router.patch('/admin/businesses/:id/reject', asyncHandler((req, res) => decideApplication(req, res, false)));

async function changeBusiness(req: Request, res: Response, suspend: boolean) {
  noQuery(req);
  const id = pathId(req.params.id), actor = actorId(req), input = parse(reasonBody, req.body);
  const result = await transaction(async client => {
    await lockAdmin(client, actor);
    const locked = await client.query(`SELECT id,verification_status FROM public.businesses WHERE id=$1 FOR UPDATE`, [id]);
    if (!locked.rows[0]) return notFound();
    if (locked.rows[0].verification_status !== (suspend ? 'APPROVED' : 'SUSPENDED')) return invalidTransition();
    await client.query(`UPDATE public.businesses SET verification_status=$2,updated_at=clock_timestamp() WHERE id=$1`, [id, suspend ? 'SUSPENDED' : 'APPROVED']);
    await audit(client, actor, suspend ? 'BUSINESS_SUSPEND' : 'BUSINESS_REACTIVATE', 'BUSINESS', id, input.reason);
    return fetchBusiness(client, id);
  });
  return ok(res, result);
}
router.patch('/admin/businesses/:id/suspend', asyncHandler((req, res) => changeBusiness(req, res, true)));
router.patch('/admin/businesses/:id/reactivate', asyncHandler((req, res) => changeBusiness(req, res, false)));

router.get('/admin/boxes', asyncHandler(async (req, res) => {
  const q = parse(queryBoxes, req.query), conditions: string[] = [], values: unknown[] = [];
  addFilter(conditions, values, p => `${effectiveBoxStatus}=${p}`, q.status);
  addFilter(conditions, values, p => `box.business_id=${p}`, q.businessId);
  addFilter(conditions, values, p => `(position(lower(${p}) in lower(box.title)) > 0 OR position(lower(${p}) in lower(b.name)) > 0)`, q.q);
  return sendPage(res, req, boxFields, 'FROM public.surprise_boxes box JOIN public.businesses b ON b.id=box.business_id', conditions, values);
}));
router.patch('/admin/boxes/:id/deactivate', asyncHandler(async (req, res) => {
  noQuery(req);
  const id = pathId(req.params.id), actor = actorId(req), input = parse(reasonBody, req.body);
  const result = await transaction(async client => {
    await lockAdmin(client, actor);
    const relation = await client.query(`SELECT business_id FROM public.surprise_boxes WHERE id=$1`, [id]);
    if (!relation.rows[0]) return notFound();
    const businessId = relation.rows[0].business_id;
    const business = await client.query(`SELECT id FROM public.businesses WHERE id=$1 FOR SHARE`, [businessId]);
    if (!business.rows[0]) return notFound();
    const locked = await client.query(`SELECT business_id,status,(pickup_end>clock_timestamp()) AS unexpired FROM public.surprise_boxes WHERE id=$1 FOR UPDATE`, [id]);
    if (!locked.rows[0] || locked.rows[0].business_id !== businessId) return notFound();
    if (locked.rows[0].status !== 'ACTIVE' || !locked.rows[0].unexpired) return invalidTransition();
    await client.query(`UPDATE public.surprise_boxes SET status='DEACTIVATED',moderation_reason=$2,updated_at=clock_timestamp() WHERE id=$1`, [id, input.reason]);
    await audit(client, actor, 'BOX_DEACTIVATE', 'BOX', id, input.reason);
    const out = await client.query(`SELECT ${boxFields} FROM public.surprise_boxes box JOIN public.businesses b ON b.id=box.business_id WHERE box.id=$1`, [id]);
    return out.rows[0];
  });
  return ok(res, result);
}));

router.get('/admin/reviews', asyncHandler(async (req, res) => {
  const q = parse(queryReviews, req.query), conditions: string[] = [], values: unknown[] = [];
  addFilter(conditions, values, p => `r.status=${p}`, q.status);
  addFilter(conditions, values, p => `r.business_id=${p}`, q.businessId);
  return sendPage(res, req, reviewFields, 'FROM public.reviews r JOIN public.profiles p ON p.id=r.customer_id', conditions, values);
}));
router.patch('/admin/reviews/:id/moderate', asyncHandler(async (req, res) => {
  noQuery(req);
  const id = pathId(req.params.id), actor = actorId(req), input = parse(moderateBody, req.body);
  const result = await transaction(async client => {
    await lockAdmin(client, actor);
    const locked = await client.query(`SELECT id,status FROM public.reviews WHERE id=$1 FOR UPDATE`, [id]);
    if (!locked.rows[0]) return notFound();
    if (locked.rows[0].status === input.status) return invalidTransition();
    await client.query(`UPDATE public.reviews SET status=$2,updated_at=clock_timestamp() WHERE id=$1`, [id, input.status]);
    await audit(client, actor, 'REVIEW_MODERATE', 'REVIEW', id, input.reason);
    const out = await client.query(`SELECT ${reviewFields} FROM public.reviews r JOIN public.profiles p ON p.id=r.customer_id WHERE r.id=$1`, [id]);
    return out.rows[0];
  });
  return ok(res, result);
}));

router.get('/admin/complaints', asyncHandler(async (req, res) => {
  const q = parse(queryComplaints, req.query), conditions: string[] = [], values: unknown[] = [];
  addFilter(conditions, values, p => `c.status=${p}`, q.status);
  addFilter(conditions, values, p => `c.target_type=${p}`, q.targetType);
  return sendPage(res, req, complaintFields, 'FROM public.complaints c', conditions, values);
}));
router.get('/admin/complaints/:id', asyncHandler(async (req, res) => {
  noQuery(req);
  const id = pathId(req.params.id);
  const result = await pool.query(`SELECT ${complaintFields} FROM public.complaints c WHERE c.id=$1`, [id]);
  if (!result.rows[0]) return notFound();
  return ok(res, result.rows[0]);
}));
router.patch('/admin/complaints/:id', asyncHandler(async (req, res) => {
  noQuery(req);
  const id = pathId(req.params.id), actor = actorId(req), input = parse(complaintBody, req.body);
  const result = await transaction(async client => {
    await lockAdmin(client, actor);
    const locked = await client.query(`SELECT id,status FROM public.complaints WHERE id=$1 FOR UPDATE`, [id]);
    if (!locked.rows[0]) return notFound();
    if (locked.rows[0].status !== 'OPEN' && !(locked.rows[0].status === 'IN_REVIEW' && input.status !== 'IN_REVIEW')) return invalidTransition();
    await client.query(`UPDATE public.complaints SET status=$2,resolution=$3,resolved_at=CASE WHEN $2='IN_REVIEW' THEN NULL ELSE clock_timestamp() END,updated_at=clock_timestamp() WHERE id=$1`, [id, input.status, input.resolution]);
    await audit(client, actor, 'COMPLAINT_UPDATE', 'COMPLAINT', id, input.resolution);
    const out = await client.query(`SELECT ${complaintFields} FROM public.complaints c WHERE c.id=$1`, [id]);
    return out.rows[0];
  });
  return ok(res, result);
}));

router.get('/admin/audit-logs', asyncHandler(async (req, res) => {
  const q = parse(queryAudit, req.query), conditions: string[] = [], values: unknown[] = [];
  addFilter(conditions, values, p => `a.actor_id=${p}`, q.actorId);
  addFilter(conditions, values, p => `a.target_type=${p}`, q.targetType);
  return sendPage(res, req, auditFields, 'FROM public.audit_logs a', conditions, values);
}));

export default router;
