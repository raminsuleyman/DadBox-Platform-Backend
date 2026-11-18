import { app } from './app.js';
import { config } from './lib/config.js';
import { pool } from './lib/db.js';
const server=app.listen(config.PORT,'0.0.0.0',()=>console.log(`PayBox API port ${config.PORT} üzərində işləyir.`));
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{ server.close(()=>{ void pool.end().finally(()=>process.exit(0)); }); });
