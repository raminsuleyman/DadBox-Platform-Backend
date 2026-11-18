import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details: unknown = null) { super(message); }
}
type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown;
export const asyncHandler = (fn: Handler): RequestHandler => (req, res, next) => { Promise.resolve(fn(req,res,next)).catch(next); };
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> { const result = schema.safeParse(value); if (!result.success) throw new HttpError(422,'VALIDATION_ERROR','Sorğunun məlumatları yanlışdır.',result.error.issues.map((i: z.ZodIssue)=>({field:i.path.join('.'),message:i.message}))); return result.data; }
export function page(req: Request) {
  const schema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });
  const result=parse(schema,{page:req.query.page,pageSize:req.query.pageSize});
  return { ...result, offset: (result.page-1)*result.pageSize };
}
export function toCamel(value: unknown): any {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(toCamel);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c:string)=>c.toUpperCase()),toCamel(v)]));
  return value;
}
export function ok(res: Response, data: unknown, status = 200) { return res.status(status).json({success:true,data:toCamel(data)}); }
export function list(res: Response, rows: unknown[], total: number | string, pageNo: number, pageSize: number) { const n=Number(total); return res.json({success:true,data:toCamel(rows),pagination:{page:pageNo,pageSize,total:n,totalPages:Math.ceil(n/pageSize)}}); }
export const uuid = z.string().uuid();
export const isoTime = z.string().datetime({ offset: true });
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction) {
  let e: HttpError;
  if (error instanceof HttpError) e = error;
  else if (error && typeof error === 'object' && 'type' in error && (error as {type:unknown}).type === 'entity.parse.failed') e = new HttpError(400,'INVALID_JSON','JSON formatı düzgün deyil.');
  else if (error && typeof error === 'object' && 'type' in error && (error as {type:unknown}).type === 'entity.too.large') e = new HttpError(413,'PAYLOAD_TOO_LARGE','Sorğunun ölçüsü çox böyükdür.');
  else if (error && typeof error === 'object' && 'code' in error) {
    const code=String((error as {code:unknown}).code);
    if (code==='23505') e=new HttpError(409,'CONFLICT','Resurs artıq mövcuddur.');
    else if (code==='23503') e=new HttpError(422,'VALIDATION_ERROR','Əlaqəli resurs yanlışdır.');
    else if (code==='23514'||code==='22P02') e=new HttpError(422,'VALIDATION_ERROR','Məlumat məhdudiyyətlərə uyğun deyil.');
    else if (code==='LIMIT_FILE_SIZE') e=new HttpError(413,'FILE_TOO_LARGE','Fayl ölçüsü icazə veriləndən böyükdür.');
    else { console.error(JSON.stringify({requestId:req.requestId,code,operation:'request_failed'})); e=new HttpError(500,'INTERNAL_ERROR','Server xətası baş verdi.'); }
  } else { console.error(JSON.stringify({requestId:req.requestId,operation:'request_failed'})); e=new HttpError(500,'INTERNAL_ERROR','Server xətası baş verdi.'); }
  if (res.headersSent) return;
  res.status(e.status).json({success:false,error:{code:e.code,message:e.message,details:e.details,requestId:req.requestId ?? null}});
}
