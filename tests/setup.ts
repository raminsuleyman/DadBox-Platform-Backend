process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable';
process.env.SUPABASE_SECRET_KEY = 'test-server-secret';
process.env.PICKUP_SECRET = 'test-only-stable-secret-12345678901234567890';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://localhost/not_used';
