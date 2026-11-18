import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

const identifiers={ customer1:'11111111-1111-4111-8111-111111111111',customer2:'22222222-2222-4222-8222-222222222222',owner:'33333333-3333-4333-8333-333333333333',admin:'44444444-4444-4444-8444-444444444444' };
vi.mock('../src/lib/supabase.js',()=>({
  supabaseAuth:{auth:{getUser:async(token:string)=>{
    const ids:Record<string,string>={customer1:'11111111-1111-4111-8111-111111111111',customer2:'22222222-2222-4222-8222-222222222222',owner:'33333333-3333-4333-8333-333333333333',admin:'44444444-4444-4444-8444-444444444444'};
    return ids[token]?{data:{user:{id:ids[token],email:`${token}@test.invalid`,email_confirmed_at:new Date().toISOString()}},error:null}:{data:{user:null},error:{status:401}};
  }}},
  supabaseAdmin:{storage:{from:()=>({})}},
}));

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL integration — only an isolated test database',()=>{
  let app:any; let pool:any;
  const biz=randomUUID(), file=randomUUID(), box=randomUUID(), futureBox=randomUUID();
  let winnerToken='', reservationId='', code='', key='';
  beforeAll(async()=>{
    ({app}=await import('../src/app.js')); ({pool}=await import('../src/lib/db.js'));
    for (const [name,uid] of Object.entries(identifiers)) {
      await pool.query("INSERT INTO auth.users(id,email,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,now(),$3::jsonb) ON CONFLICT(id) DO NOTHING",[uid,`${name}@test.invalid`,JSON.stringify({full_name:name})]);
      await pool.query("INSERT INTO public.profiles(id,full_name,role,status) VALUES($1,$2,$3,'ACTIVE') ON CONFLICT(id) DO UPDATE SET role=EXCLUDED.role,status='ACTIVE'",[uid,name,name==='admin'?'ADMIN':name==='owner'?'BUSINESS_OWNER':'CUSTOMER']);
    }
    await pool.query("INSERT INTO public.businesses(id,owner_id,name,description,category,address,latitude,longitude,contact_phone,verification_status) VALUES($1,$2,'Test Bakery','Local test','BAKERY','Baku Test Street',40.4,49.8,'+994501234567','APPROVED')",[biz,identifiers.owner]);
    await pool.query("INSERT INTO public.uploads(id,business_id,uploaded_by,purpose,bucket,object_path,mime_type,size_bytes,state) VALUES($1,$2,$3,'BOX_IMAGE','surprise-box-images',$4,'image/jpeg',100,'READY')",[file,biz,identifiers.owner,`test/${file}.jpg`]);
    const insert="INSERT INTO public.surprise_boxes(id,business_id,title,description,category,original_price_minor,discounted_price_minor,available_quantity,pickup_start,pickup_end,allergens,food_info,image_file_id,status) VALUES($1,$2,'Test box','Description for test','BAKERY',1500,500,$3,$4,$5,ARRAY['gluten'],'Test food information',$6,'ACTIVE')";
    await pool.query(insert,[box,biz,1,new Date(Date.now()-60000),new Date(Date.now()+7200000),file]);
    await pool.query(insert,[futureBox,biz,2,new Date(Date.now()+3600000),new Date(Date.now()+7200000),file]);
  });
  afterAll(async()=>{ if(pool) await pool.end(); });
  it('health and authentication restrictions',async()=>{ expect((await request(app).get('/health/live')).status).toBe(200); expect((await request(app).get('/api/v1/auth/me')).status).toBe(401); expect((await request(app).get('/api/v1/admin/users').set('Authorization','Bearer customer1')).status).toBe(403); });
  it('last unit is reserved by only one of two concurrent requests',async()=>{
    const keys=[randomUUID(),randomUUID()];
    const results=await Promise.all(['customer1','customer2'].map((token,i)=>request(app).post('/api/v1/reservations').set('Authorization',`Bearer ${token}`).set('Idempotency-Key',keys[i]).send({boxId:box,quantity:1})));
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
    const wi=results.findIndex(r=>r.status===201); winnerToken=['customer1','customer2'][wi]; key=keys[wi]; reservationId=results[wi].body.data.id; code=results[wi].body.data.pickupCode;
    expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect((await pool.query('SELECT available_quantity FROM public.surprise_boxes WHERE id=$1',[box])).rows[0].available_quantity).toBe(0);
  });
  it('replays same idempotency key without reducing inventory again',async()=>{
    const repeat=await request(app).post('/api/v1/reservations').set('Authorization',`Bearer ${winnerToken}`).set('Idempotency-Key',key).send({boxId:box,quantity:1});
    expect(repeat.status).toBe(201); expect(repeat.body.data.id).toBe(reservationId); expect(repeat.body.data.pickupCode).toBe(code);
    expect((await pool.query('SELECT available_quantity FROM public.surprise_boxes WHERE id=$1',[box])).rows[0].available_quantity).toBe(0);
  });
  it('rejects wrong pickup code and accepts the valid owner/code',async()=>{
    const wrong=await request(app).patch(`/api/v1/reservations/${reservationId}/pickup`).set('Authorization','Bearer owner').set('Idempotency-Key',randomUUID()).send({pickupCode:'AAAA-AAAA-AAAA'});
    expect(wrong.status).toBe(409);
    const right=await request(app).patch(`/api/v1/reservations/${reservationId}/pickup`).set('Authorization','Bearer owner').set('Idempotency-Key',randomUUID()).send({pickupCode:code});
    expect(right.status).toBe(200); expect(right.body.data.status).toBe('PICKED_UP'); expect(right.body.data.pickupCode).toBeNull();
  });
  it('cancellation restores stock exactly once and is idempotent',async()=>{
    const created=await request(app).post('/api/v1/reservations').set('Authorization','Bearer customer1').set('Idempotency-Key',randomUUID()).send({boxId:futureBox,quantity:1}); expect(created.status).toBe(201);
    const cancelKey=randomUUID(); const path=`/api/v1/reservations/${created.body.data.id}/cancel`;
    const one=await request(app).patch(path).set('Authorization','Bearer customer1').set('Idempotency-Key',cancelKey).send({reason:null});
    const two=await request(app).patch(path).set('Authorization','Bearer customer1').set('Idempotency-Key',cancelKey).send({reason:null});
    expect(one.status).toBe(200); expect(two.status).toBe(200); expect((await pool.query('SELECT available_quantity FROM public.surprise_boxes WHERE id=$1',[futureBox])).rows[0].available_quantity).toBe(2);
  });
});
