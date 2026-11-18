import { Router } from 'express';
import type { RequestHandler } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { pool, transaction } from '../lib/db.js';
import { HttpError, asyncHandler, ok, parse } from '../lib/http.js';
import { requireAuth, optionalAuth, requireVerified, requireRole } from '../middleware/auth.js';
import { supabaseAdmin } from '../lib/supabase.js';

const router = Router();
const uuid = z.string().uuid();
const emptyQuery = z.object({}).strict();
const purposes = ['BUSINESS_IMAGE', 'BOX_IMAGE', 'VERIFICATION_DOCUMENT'] as const;
type Purpose = typeof purposes[number];
const formSchema = z.object({ businessId: uuid, purpose: z.enum(purposes) }).strict();
const buckets: Record<Purpose, string> = {
  BUSINESS_IMAGE: 'business-images', BOX_IMAGE: 'surprise-box-images', VERIFICATION_DOCUMENT: 'verification-documents',
};
const IMAGE_LIMIT = 5 * 1024 * 1024;
const DOCUMENT_LIMIT = 10 * 1024 * 1024;
const notFound = () => new HttpError(404, 'NOT_FOUND', 'Resurs tapılmadı.');
const tooLarge = () => new HttpError(413, 'FILE_TOO_LARGE', 'Fayl ölçüsü icazə veriləndən böyükdür.');
const unavailable = () => new HttpError(503, 'SERVICE_UNAVAILABLE', 'Fayl xidməti hazırda əlçatan deyil.');

// Busboy emits partsLimit on reaching the configured count; 4 permits exactly 3 parts.
const receive = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DOCUMENT_LIMIT, files: 1, fields: 2, parts: 4, fieldSize: 1024, fieldNameSize: 100 },
}).single('file');
const receiveFile: RequestHandler = (req, res, next) => {
  if (!req.is('multipart/form-data')) return next(new HttpError(400, 'INVALID_MULTIPART', 'Multipart sorğusu tələb olunur.'));
  receive(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return next(tooLarge());
      return next(new HttpError(422, 'VALIDATION_ERROR', 'Multipart sahələri və ya fayl sayı yanlışdır.'));
    }
    return next(new HttpError(400, 'INVALID_MULTIPART', 'Multipart sorğusu oxuna bilmədi.'));
  });
};

type Detected = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
function detect(buffer: Buffer): Detected | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 8 && /^%PDF-[12]\.[0-9]/.test(buffer.toString('ascii', 0, 8))) return 'application/pdf';
  return null;
}

// A real parser is used, not just the header. This does NOT scan or sanitize active PDF content.
// pdfinfo must be installed and isolated/hardened by the deployment; a missing parser fails closed.
function validatePdf(buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pdfinfo', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new HttpError(422, 'VALIDATION_ERROR', 'PDF faylı oxuna bilmədi.'));
    }, 5000);
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on('error', () => { /* pdfinfo can exit before consuming invalid input */ });
    child.once('error', () => finish(unavailable()));
    child.once('close', code => finish(code === 0 ? undefined : new HttpError(422, 'VALIDATION_ERROR', 'PDF faylı oxuna bilmədi.')));
    child.stdin.end(buffer);
  });
}

async function prepare(buffer: Buffer, purpose: Purpose): Promise<{ data: Buffer; mimeType: Detected }> {
  const mimeType = detect(buffer);
  if (!mimeType || (mimeType === 'application/pdf' && purpose !== 'VERIFICATION_DOCUMENT')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Bu fayl növünə icazə verilmir.');
  }
  const limit = mimeType === 'application/pdf' ? DOCUMENT_LIMIT : IMAGE_LIMIT;
  if (buffer.length > limit) throw tooLarge();
  if (mimeType === 'application/pdf') {
    await validatePdf(buffer);
    return { data: buffer, mimeType };
  }
  try {
    const decoder = sharp(buffer, { failOn: 'warning', limitInputPixels: 40_000_000, animated: false });
    const metadata = await decoder.metadata();
    const expected = mimeType === 'image/jpeg' ? 'jpeg' : mimeType === 'image/png' ? 'png' : 'webp';
    if (metadata.format !== expected || !metadata.width || !metadata.height || (metadata.pages && metadata.pages > 1)) {
      throw new Error('Invalid or multi-page image');
    }
    // Sharp drops metadata by default; rotate applies EXIF orientation before removing EXIF.
    let encoder = decoder.rotate();
    if (mimeType === 'image/jpeg') encoder = encoder.jpeg({ quality: 85 });
    else if (mimeType === 'image/png') encoder = encoder.png();
    else encoder = encoder.webp({ quality: 85 });
    const data = await encoder.toBuffer();
    if (data.length > IMAGE_LIMIT) throw tooLarge();
    return { data, mimeType };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(422, 'VALIDATION_ERROR', 'Şəkil faylı oxuna bilmədi.');
  }
}

async function assertPrivateBucket(bucket: string) {
  try {
    const { data, error } = await supabaseAdmin.storage.getBucket(bucket);
    if (error || !data || data.public !== false) throw unavailable();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
}

async function removeAfterFailure(bucket: string, objectPath: string, businessId: string, uploadId: string) {
  try {
    const { error } = await supabaseAdmin.storage.from(bucket).remove([objectPath]);
    if (error) throw error;
  } catch {
    // No secret, signed URL, or raw path is logged. IDs let an operator reconcile the orphan.
    console.error(JSON.stringify({ operation: 'upload_cleanup_failed', bucket, businessId, uploadId }));
  }
}

router.post('/uploads', requireAuth, requireRole('BUSINESS_OWNER'), requireVerified, receiveFile, asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const input = parse(formSchema, req.body);
  if (!req.file) throw new HttpError(422, 'VALIDATION_ERROR', 'Bir fayl tələb olunur.');
  const actorId = req.actor!.id;
  // Cheap check before spending CPU or using storage; the same conditions are locked again at insert.
  const initial = (await pool.query(`SELECT b.verification_status FROM public.businesses b
    JOIN public.profiles p ON p.id=b.owner_id WHERE b.id=$1 AND b.owner_id=$2 AND p.status='ACTIVE' AND p.role='BUSINESS_OWNER'`,
    [input.businessId, actorId])).rows[0];
  if (!initial) throw notFound();
  if (input.purpose === 'BOX_IMAGE' && initial.verification_status !== 'APPROVED') {
    throw new HttpError(409, 'INVALID_TRANSITION', 'Qutu şəkli üçün biznes təsdiqlənmiş olmalıdır.');
  }
  const prepared = await prepare(req.file.buffer, input.purpose);
  const bucket = buckets[input.purpose];
  await assertPrivateBucket(bucket);
  const uploadId = randomUUID();
  const objectPath = `${input.businessId}/${uploadId}`;
  try {
    const { error } = await supabaseAdmin.storage.from(bucket).upload(objectPath, prepared.data, {
      contentType: prepared.mimeType, upsert: false,
    });
    if (error) throw unavailable();
    const result = await transaction(async c => {
      const actor = (await c.query('SELECT role, status FROM public.profiles WHERE id=$1 FOR SHARE', [actorId])).rows[0];
      if (!actor || actor.status !== 'ACTIVE') throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'Hesab aktiv deyil.');
      if (actor.role !== 'BUSINESS_OWNER') throw new HttpError(403, 'FORBIDDEN', 'Bu əməliyyat üçün icazəniz yoxdur.');
      const business = (await c.query('SELECT verification_status FROM public.businesses WHERE id=$1 AND owner_id=$2 FOR SHARE', [input.businessId, actorId])).rows[0];
      if (!business) throw notFound();
      if (input.purpose === 'BOX_IMAGE' && business.verification_status !== 'APPROVED') {
        throw new HttpError(409, 'INVALID_TRANSITION', 'Qutu şəkli üçün biznes təsdiqlənmiş olmalıdır.');
      }
      return (await c.query(`INSERT INTO public.uploads (id, business_id, uploaded_by, purpose, bucket, object_path, mime_type, size_bytes, state)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'READY')
        RETURNING id, business_id, purpose, mime_type, size_bytes, created_at`,
      [uploadId, input.businessId, actorId, input.purpose, bucket, objectPath, prepared.mimeType, prepared.data.length])).rows[0];
    });
    return ok(res, result, 201);
  } catch (error) {
    // Also clean up after an ambiguous upload failure, since the object may have been created.
    await removeAfterFailure(bucket, objectPath, input.businessId, uploadId);
    if (error instanceof HttpError) throw error;
    // Unexpected DB errors are handled centrally without revealing storage internals.
    throw error;
  }
}));

router.get('/uploads/:id/access', optionalAuth, asyncHandler(async (req, res) => {
  parse(emptyQuery, req.query);
  const id = parse(uuid, req.params.id);
  const actorId = req.actor?.id ?? null;
  const result = await pool.query(`SELECT u.bucket, u.object_path, u.purpose
    FROM public.uploads u JOIN public.businesses b ON b.id=u.business_id
    JOIN public.profiles owner ON owner.id=b.owner_id
    LEFT JOIN public.profiles actor ON actor.id=$2::uuid AND actor.status='ACTIVE'
    WHERE u.id=$1 AND u.state='READY' AND (
      (actor.id IS NOT NULL AND (actor.role='ADMIN' OR (actor.id=b.owner_id AND actor.role='BUSINESS_OWNER')))
      OR (b.verification_status='APPROVED' AND owner.status='ACTIVE' AND (
        (u.purpose='BUSINESS_IMAGE' AND b.image_file_id=u.id)
        OR (u.purpose='BOX_IMAGE' AND EXISTS (SELECT 1 FROM public.surprise_boxes x
          WHERE x.business_id=b.id AND x.image_file_id=u.id AND x.status='ACTIVE'
            AND x.available_quantity>0 AND x.pickup_end>clock_timestamp()))
      ))
    )`, [id, actorId]);
  const upload = result.rows[0];
  if (!upload || !purposes.includes(upload.purpose as Purpose) || buckets[upload.purpose as Purpose] !== upload.bucket) throw notFound();
  await assertPrivateBucket(upload.bucket);
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  let url: string;
  try {
    const { data, error } = await supabaseAdmin.storage.from(upload.bucket).createSignedUrl(upload.object_path, 300);
    if (error || !data?.signedUrl) throw unavailable();
    url = data.signedUrl;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw unavailable();
  }
  res.setHeader('Cache-Control', 'private, no-store');
  return ok(res, { url, expiresAt });
}));

export default router;
