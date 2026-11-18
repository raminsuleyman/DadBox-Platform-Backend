import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
const options = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
export const supabaseAuth = createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, options);
// Server-side only. Never return this client or secret key to a caller.
export const supabaseAdmin = createClient(config.SUPABASE_URL, config.SUPABASE_SECRET_KEY, options);
