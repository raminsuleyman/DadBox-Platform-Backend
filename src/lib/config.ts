import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development','test','production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(5000),
  FRONTEND_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  PICKUP_SECRET: z.string().min(32),
  TRUST_PROXY: z.enum(['0','1']).default('0'),
});
const result = schema.safeParse(process.env);
if (!result.success) {
  console.error('Mühit dəyişənləri yanlışdır:', result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  throw new Error('Invalid environment configuration');
}
if (result.data.PICKUP_SECRET.startsWith('REPLACE_WITH_')) throw new Error('PICKUP_SECRET üçün təhlükəsiz təsadüfi açar təyin edin.');
export const config = result.data;
