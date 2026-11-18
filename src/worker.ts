import { pool, transaction } from './lib/db.js';

// Run separately from the web server. Each candidate is rechecked under row locks.
async function expireBatch() {
  const ids=await pool.query(`SELECT r.id,r.surprise_box_id FROM public.reservations r WHERE r.status IN ('PENDING','CONFIRMED') AND r.pickup_end<=clock_timestamp() ORDER BY r.pickup_end,r.id LIMIT 100`);
  for (const candidate of ids.rows) {
    await transaction(async c=>{
      await c.query('SELECT id FROM public.surprise_boxes WHERE id=$1 FOR UPDATE',[candidate.surprise_box_id]);
      const r=(await c.query('SELECT id,status,pickup_end FROM public.reservations WHERE id=$1 FOR UPDATE',[candidate.id])).rows[0];
      if (!r || !['PENDING','CONFIRMED'].includes(r.status) || new Date(r.pickup_end).getTime()>Date.now()) return;
      await c.query("UPDATE public.reservations SET status='EXPIRED',updated_at=clock_timestamp() WHERE id=$1",[r.id]);
      await c.query("INSERT INTO public.reservation_events(reservation_id,actor_id,from_status,to_status,occurred_at) VALUES($1,NULL,$2,'EXPIRED',$3)",[r.id,r.status,r.pickup_end]);
      await c.query("INSERT INTO public.outbox(event_type,aggregate_id,payload) VALUES('reservation.expired',$1,$2::jsonb)",[r.id,JSON.stringify({reservationId:r.id})]);
    });
  }
  await pool.query("UPDATE public.surprise_boxes SET status='EXPIRED',updated_at=clock_timestamp() WHERE status='ACTIVE' AND pickup_end<=clock_timestamp()");
  await pool.query('DELETE FROM public.idempotency_records WHERE expires_at<clock_timestamp() AND http_status<>0');
}
let stopping=false;
async function run() { while (!stopping) { try { await expireBatch(); } catch { console.error('Expiry worker əməliyyatı uğursuz oldu; növbəti dövrədə yenidən yoxlanacaq.'); } await new Promise(resolve=>setTimeout(resolve,60_000)); } await pool.end(); }
process.on('SIGTERM',()=>{stopping=true;}); process.on('SIGINT',()=>{stopping=true;});
void run();
