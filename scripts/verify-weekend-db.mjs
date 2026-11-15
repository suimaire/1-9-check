import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL SQL/RLS; only Supabase auth/storage and the clock are local stubs.
// The production migrations have no clock override. No network or production writes.
const root = new URL('../supabase/migrations/', import.meta.url);
const stubSource = readFileSync(new URL('./verify-public-db.mjs', import.meta.url), 'utf8');
const stub = stubSource.match(/const STUB = `([\s\S]*?)`;/)[1];
const db = new PGlite();
await db.exec(stub);
await db.exec(`create schema test_clock;
create function test_clock.now() returns timestamptz language sql stable as $$
 select current_setting('test.now')::timestamptz $$;
grant usage on schema test_clock to anon, authenticated, service_role;`);
const clock = (at) => db.query(`select set_config('test.now', $1, false)`, [at]);
await clock('2026-11-21T00:00:00+09:00');
const apply = async (file) => db.exec(readFileSync(new URL(file, root), 'utf8').replace(/\bnow\(\)/g, 'test_clock.now()'));
const files = readdirSync(root).filter(f => f.endsWith('.sql')).sort();
for (const f of files.slice(0, 3)) await apply(f);
const teacher = randomUUID(), outsider = randomUUID(), oldStudent = randomUUID();
const cls = randomUUID(), cls2 = randomUUID(), s1 = randomUUID(), s2 = randomUUID(), s3 = randomUUID();
await db.query(`insert into auth.users (id) values ($1),($2),($3)`, [teacher, outsider, oldStudent]);
await db.query(`insert into public.profiles (user_id, role, display_name, must_change_password)
values ($1,'teacher','Teacher',false),($2,'teacher','Other',false),($3,'student','Student',false)`, [teacher, outsider, oldStudent]);
await db.query(`insert into public.classes (id,name,public_submit) values ($1,'Class',true),($2,'Other',false)`, [cls, cls2]);
await db.query(`insert into public.class_teachers values ($1,$2),($3,$4)`, [cls, teacher, cls2, outsider]);
await db.query(`insert into public.students (id,class_id,student_no,name,user_id) values
($1,$2,'10901','One',$3),($4,$2,'10902','Two',null),($5,$6,'20901','Other',null)`, [s1, cls, oldStudent, s2, s3, cls2]);
async function as(role, uid, sql, params = []) {
  await db.exec(`reset role; set role ${role}`);
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid ?? '']);
  try { return await db.query(sql, params); }
  finally { await db.exec('reset role'); await db.query(`select set_config('request.jwt.claim.sub', '', false)`); }
}
const teach = (sql, params=[]) => as('authenticated', teacher, sql, params);
const rpc = async (sql, params=[]) => (await as('service_role', null, sql, params)).rows[0]?.r;
const legacy = (await teach(`select public.save_term($1,null,'Legacy','2026-10-02','2026-12-31',480,null,null,'') id`, [cls])).rows[0].id;
const hash = 'a'.repeat(64), hash2 = 'b'.repeat(64), hash3 = 'c'.repeat(64);
async function images(term, student=s1, n=1) {
  const result = [];
  for (let i=0;i<n;i++) {
    const path = `${student}/${term}/${randomUUID()}.webp`;
    await db.query(`insert into storage.objects (bucket_id,name) values ('screenshots',$1)`, [path]);
    result.push({path,mime:'image/webp',bytes:1000});
  }
  return result;
}
const submit = (date, req=randomUUID(), imgs=null, token=null, fresh=hash, no='10901') => rpc(
  `select public.public_submit_images($1,$2,$3,$4,$5,$6::jsonb,60,'test') r`, [no,date,req,token,fresh,imgs ? JSON.stringify(imgs) : null]);
await submit('2026-11-20', randomUUID(), await images(legacy));
async function snapshotLegacy() {
 return (await db.query(`select jsonb_build_object(
 'days',(select jsonb_agg(to_jsonb(d) order by record_date) from public.term_days d where term_id=$1),
 'subs',(select jsonb_agg(to_jsonb(s) order by id) from public.submissions s where term_id=$1),
 'images',(select jsonb_agg(to_jsonb(i) order by i.id) from public.submission_images i join public.submissions s on s.id=i.submission_id where s.term_id=$1),
 'events',(select jsonb_agg(to_jsonb(e) order by request_id) from public.submission_events e join public.submissions s on s.id=e.submission_id where s.term_id=$1),
 'objects',(select jsonb_agg(to_jsonb(o) order by id) from storage.objects o)) as r`, [legacy])).rows[0].r;
}
const before = await snapshotLegacy();
for (const f of files.slice(3)) await apply(f);
const exists = (await db.query(`select to_regprocedure('public.save_weekend_term(uuid,uuid,text,integer,text)') is not null ok`)).rows[0].ok;
assert.ok(exists, 'weekend teacher RPC exists after migration');
let passed=0;
function check(name, fn) { return Promise.resolve().then(fn).then(() => { passed++; console.log(`PASS ${name}`); }); }
const reject = (fn, code) => assert.rejects(fn, new RegExp(code));
await check('migration preserves legacy days, submissions, images, events and objects', async()=> assert.deepEqual(await snapshotLegacy(), before));
const weekend = (await teach(`select public.save_weekend_term($1,null,'Weekend',540,'Instructions') id`, [cls])).rows[0].id;
const dates = ['2026-11-21','2026-11-22','2026-11-28','2026-11-29','2026-12-05','2026-12-06'];
const allDates = ['2026-11-14','2026-11-15',...dates];
const mondayOpen = ['2026-11-15T15:00:00.000Z','2026-11-15T15:00:00.000Z','2026-11-22T15:00:00.000Z','2026-11-22T15:00:00.000Z','2026-11-29T15:00:00.000Z','2026-11-29T15:00:00.000Z','2026-12-06T15:00:00.000Z','2026-12-06T15:00:00.000Z'];
const days = async()=> (await db.query(`select record_date::text,window_open_at,deadline_at from public.term_days where term_id=$1 order by record_date`,[weekend])).rows;
await check('exactly eight dates with each weekend opening together Monday 00:00 / 09:00 KST', async()=> {
 const rows=await days(); assert.deepEqual(rows.map(r=>r.record_date), allDates);
 for (let i=0;i<rows.length;i++) { const r=rows[i]; const open=new Date(mondayOpen[i]).getTime(); assert.equal(new Date(r.window_open_at).toISOString(),mondayOpen[i]); assert.equal(new Date(r.deadline_at).getTime(),open+9*3600000); }
 const term=(await db.query(`select * from public.terms where id=$1`,[weekend])).rows[0];
 assert.equal(new Date(term.start_date).toISOString().slice(0,10),'2026-11-14'); assert.equal(term.submission_mode,'weekend'); assert.equal(new Date(term.final_close_at).toISOString(),'2026-12-07T14:59:59.999Z');
});
await check('creation does not pin or change the legacy term',async()=> { const info=await rpc('select public.public_info() r'); assert.equal(info.term.id,legacy); assert.deepEqual(await snapshotLegacy(),before); });
await check('an unpinned weekend cannot shadow legacy public submission',async()=> {
 await clock('2026-11-22T12:00:00+09:00');
 assert.equal((await submit(dates[0])).term_id,legacy);
 await clock('2026-11-21T00:00:00+09:00');
});
await check('teacher RPC authorization and cross-class pin protection',async()=> {
 for (const uid of [outsider,oldStudent]) {
  await reject(()=>as('authenticated',uid,`select public.save_weekend_term($1,null,'No',540,'')`,[cls]),'not_allowed');
  await reject(()=>as('authenticated',uid,`select public.set_public_term($1,$2)`,[cls,weekend]),'not_allowed');
  await reject(()=>as('authenticated',uid,`select public.set_term_participants($1,$2::uuid[])`,[weekend,[s1]]),'not_allowed');
 }
 await reject(()=>teach(`select public.set_public_term($1,$2)`,[cls2,weekend]),'not_allowed');
 await reject(()=>as('anon',null,`select public.save_weekend_term($1,null,'No',540,'')`,[cls]),'permission denied');
});
await teach(`select public.set_public_term($1,$2)`,[cls,weekend]);
await clock('2026-11-15T12:00:00+09:00');
await check('pinned info before Monday shows no open dates and identifies the next weekend',async()=> {
 const info=await rpc('select public.public_info() r'); assert.equal(info.term.id,weekend); assert.equal(info.term.submission_mode,'weekend');
 assert.deepEqual(info.open_days,[]); assert.equal(info.next_day.record_date,allDates[0]); assert.ok(!JSON.stringify(info).includes(s1));
});
await check('pinned submit cannot fall back to overlapping legacy dates',async()=> { await reject(()=>submit('2026-11-20'),'date_out_of_range'); });
await check('participant enrollment validation and SELECT privacy',async()=> {
 await reject(()=>teach(`select public.set_term_participants($1,$2::uuid[])`,[weekend,[s3]]),'not_allowed');
 await teach(`select public.set_term_participants($1,$2::uuid[])`,[weekend,[s1,s1]]);
 assert.equal((await teach(`select * from public.term_participants where term_id=$1`,[weekend])).rows.length,1);
 for(const uid of [outsider,oldStudent]) assert.equal((await as('authenticated',uid,`select * from public.term_participants`)).rows.length,0);
 await reject(()=>as('anon',null,'select * from public.term_participants'),'permission denied');
 await reject(()=>teach(`update public.term_participants set active=false`),'permission denied');
 await reject(()=>teach(`update public.classes set public_term_id=null where id=$1`,[cls]),'permission denied');
});
await check('November 14 and 15 open together on November 16 with matching 09:00 deadlines',async()=> {
 await clock('2026-11-15T23:59:59.999+09:00');
 await reject(()=>submit(allDates[0]),'window_not_open');
 await db.exec('begin');
 try {
  await clock('2026-11-16T00:00:00+09:00');
  const info=await rpc('select public.public_info() r');
  assert.deepEqual(info.open_days.map(d=>d.record_date).sort(),allDates.slice(0,2));
  assert.equal(info.next_day.record_date,dates[0]);
  for(const day of info.open_days) assert.equal(new Date(day.deadline_at).toISOString(),'2026-11-16T00:00:00.000Z');
  await clock('2026-11-16T08:59:59.999+09:00');
  assert.equal((await submit(allDates[0],randomUUID(),await images(weekend))).late,false);
  await clock('2026-11-16T09:00:00+09:00');
  assert.equal((await submit(allDates[1],randomUUID(),await images(weekend))).late,false);
  await teach('select public.set_term_participants($1,$2::uuid[])',[weekend,[s1,s2]]);
  await clock('2026-11-16T09:00:00.001+09:00');
  for(const d of allDates.slice(0,2)) assert.equal((await submit(d,randomUUID(),await images(weekend,s2),null,hash,'10902')).late,true);
 } finally { await db.exec('rollback'); }
});
await check('excluded, same-day and future submissions rejected',async()=> {
 await reject(()=>submit(dates[0],randomUUID(),null,null,hash,'10902'),'not_participant');
 await reject(()=>submit(dates[0]),'window_not_open'); await reject(()=>submit(dates[5]),'window_not_open');
});
await check('Saturday cannot be submitted on Sunday before Monday opens',async()=> {
 await clock('2026-11-22T23:59:59.999+09:00'); await reject(()=>submit(dates[0]),'window_not_open');
});
await check('November 23 exposes both opened pairs without future dates',async()=> {
 await clock('2026-11-23T00:00:00+09:00'); const info=await rpc('select public.public_info() r');
 assert.deepEqual(info.open_days.map(d=>d.record_date).sort(),allDates.slice(0,4)); assert.equal(info.next_day.record_date,dates[2]);
});
await clock('2026-11-23T08:59:59+09:00');
await check('a stale form cannot submit into a different public term',async()=> {
 await teach(`select public.set_public_term($1,null)`,[cls]);
 await reject(()=>rpc(`select public.public_submit_images_for_term($1,'10901',$2,$3,null,$4,null,null,null) r`,[weekend,dates[0],randomUUID(),hash]),'term_changed');
 await teach(`select public.set_public_term($1,$2)`,[cls,weekend]);
});
const req=randomUUID();
await check('initial three-image submission uses the pinned term and is on time',async()=> {
 const pre=await submit(dates[0],req); assert.equal(pre.term_id,weekend);
 const result=await submit(dates[0],req,await images(weekend,s1,3)); assert.equal(result.image_count,3); assert.equal(result.late,false); assert.equal(result.version,1);
});
await check('request replay binds student and date, with no extra images or events',async()=> {
 await reject(()=>submit(dates[1],req),'bad_request');
 await reject(()=>submit(dates[0],req,null,null,hash2,'10902'),'bad_request');
 const result=await submit(dates[0],req,null,null,hash2); assert.equal(result.replayed,true); assert.equal(result.image_count,3); assert.equal(result.token_issued,true);
});
await check('receipt recovery needs the exact request, student, date and term',async()=> {
 const recover=(term,no,date,id)=>rpc(`select public.public_recover_submission($1,$2,$3,$4,$5) r`,[term,no,date,id,hash2]);
 assert.equal((await recover(weekend,'10901',dates[0],req)).replayed,true);
 assert.equal(await recover(weekend,'10901',dates[1],randomUUID()),null);
 await reject(()=>recover(legacy,'10901',dates[0],req),'term_changed');
 await reject(()=>recover(weekend,'10902',dates[0],req),'bad_request');
 await reject(()=>recover(weekend,'10901',dates[1],req),'bad_request');
 for (const role of ['anon','authenticated']) {
  await reject(()=>as(role,teacher,`select public.public_recover_submission($1,'10901',$2,$3,$4)`,[weekend,dates[0],req,hash2]),'permission denied');
  await reject(()=>as(role,teacher,`select public.public_submit_images_for_term($1,'10901',$2,$3,null,$4,null,null,null)`,[weekend,dates[0],req,hash2]),'permission denied');
 }
});
await check('removing enrollment blocks replacement and replay but preserves history and roster',async()=> {
 await teach(`select public.set_term_participants($1,'{}'::uuid[])`,[weekend]);
 await reject(()=>submit(dates[0],req),'not_participant'); await reject(()=>submit(dates[0],randomUUID(),null,hash2),'not_participant');
 assert.equal((await teach('select id from public.submissions where term_id=$1',[weekend])).rows.length,1);
 assert.equal((await db.query('select active from public.students where id=$1',[s1])).rows[0].active,true);
 await teach(`select public.set_term_participants($1,$2::uuid[])`,[weekend,[s1,s2]]);
});
await check('enrollment is rechecked after upload and before commit',async()=> {
 const pending=randomUUID(); assert.equal((await submit(dates[0],pending,null,null,hash,'10902')).ready,true);
 const uploaded=await images(weekend,s2,2);
 await teach('select public.set_term_participants($1,$2::uuid[])',[weekend,[s1]]);
 await reject(()=>submit(dates[0],pending,uploaded,null,hash,'10902'),'not_participant');
 assert.equal((await db.query('select count(*)::int n from public.submissions where term_id=$1 and student_id=$2',[weekend,s2])).rows[0].n,0);
 await teach('select public.set_term_participants($1,$2::uuid[])',[weekend,[s1,s2]]);
});
await check('submission transaction holds locks on pin, enrollment, term and date',async()=> {
 await db.exec('begin');
 try {
  await submit(dates[0],randomUUID(),null,hash2);
  const rows=(await db.query("select c.relname from pg_locks l join pg_class c on c.oid=l.relation where l.pid=pg_backend_pid() and l.mode='RowShareLock' and l.granted")).rows;
  for(const name of ['classes','students','terms','term_days','term_participants']) assert.ok(rows.some(r=>r.relname===name),name);
 } finally { await db.exec('rollback'); }
});
await clock('2026-11-23T12:00:00+09:00');
await check('replacement preserves first submission and all image history; replacement replay is idempotent',async()=> {
 const replaceReq=randomUUID(); const result=await submit(dates[0],replaceReq,await images(weekend,s1,2),hash2); assert.equal(result.version,2); assert.equal(result.late,false); assert.equal(result.image_count,2);
 const replay=await submit(dates[0],replaceReq,null,hash2); assert.equal(replay.replayed,true); assert.equal(replay.version,2);
 assert.equal((await db.query('select count(*)::int n from public.submission_images i join public.submissions s on s.id=i.submission_id where s.term_id=$1',[weekend])).rows[0].n,5);
});
await check('late initial submission remains separate for the next date',async()=> { const r=await submit(dates[1],randomUUID(),await images(weekend)); assert.equal(r.late,true); assert.equal(r.version,1); });
await check('teacher deadline edit preserves opened dates and updates only unopened dates',async()=> {
 const old=await days(); await teach(`select public.save_weekend_term($1,$2,'Updated',600,'New')`,[cls,weekend]); const newer=await days();
 for(let i=0;i<allDates.length;i++) assert.equal(new Date(newer[i].deadline_at).getTime()-new Date(old[i].deadline_at).getTime(),i<4?0:3600000);
 await reject(()=>db.query(`update public.term_days set window_open_at=window_open_at+interval '1 minute' where term_id=$1 and record_date=$2`,[weekend,dates[0]]),'deadline_locked');
 await reject(()=>teach(`select public.save_term($1,$2,'Bypass','2026-11-21','2026-12-06',540,null,null,'')`,[cls,weekend]),'wrong_submission_mode');
 await reject(()=>teach(`select public.set_day_target($1,$2,false,'')`,[weekend,dates[0]]),'weekend_dates_fixed');
});
await check('deadline equality is on time and one millisecond later is late',async()=> {
 await clock('2026-11-30T00:00:00+09:00'); assert.deepEqual((await rpc('select public.public_info() r')).open_days.map(d=>d.record_date).sort(),allDates.slice(0,6));
 await clock('2026-11-30T10:00:00+09:00'); assert.equal((await submit(dates[2],randomUUID(),await images(weekend))).late,false);
 await clock('2026-11-30T10:00:00.001+09:00'); assert.equal((await submit(dates[3],randomUUID(),await images(weekend))).late,true);
});
await check('final close rejects new submission while receipt replay stays available',async()=> {
 await clock('2026-12-07T23:59:59.999+09:00'); assert.deepEqual((await rpc('select public.public_info() r')).open_days.map(d=>d.record_date).sort(),allDates); assert.equal((await submit(dates[5],randomUUID(),null,null,hash,'10902')).ready,true);
 await clock('2026-12-08T00:00:00+09:00'); await reject(()=>submit(dates[5],randomUUID(),null,null,hash,'10902'),'window_closed');
 assert.equal((await submit(dates[0],req,null,null,hash3)).replayed,true);
 const closedInfo=await rpc('select public.public_info() r'); assert.equal(closedInfo.term.id,weekend); assert.deepEqual(closedInfo.open_days,[]); assert.equal(closedInfo.next_day,null);
});
await check('clearing the pin restores legacy selection and leaves its data untouched',async()=> {
 await teach(`select public.set_public_term($1,null)`,[cls]); assert.equal((await rpc('select public.public_info() r')).term.id,legacy);
 assert.equal((await submit('2026-12-07',randomUUID(),null,null,hash,'10902')).term_id,legacy);
 const after=await snapshotLegacy(); assert.deepEqual({...after,objects:before.objects},before);
});
console.log(`${passed}/${passed} weekend DB checks passed (local PGlite; auth/storage/clock stubs)`);
await db.close();
