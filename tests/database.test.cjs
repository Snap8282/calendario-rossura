const {test, before, after, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {PGlite} = require('@electric-sql/pglite');
const {pgcrypto} = require('@electric-sql/pglite/contrib/pgcrypto');

// In-memory PostgreSQL with real pgcrypto, RLS, constraints and SQL functions.
// No URL, network connection, or production data is used by these tests.
let db;
before(async () => {
  db = new PGlite({extensions: {pgcrypto}});
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema extensions; grant usage on schema extensions to public;`);
  // Reproduce legacy Supabase grants to ensure schema is safe under that configuration.
  await db.exec(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  await db.exec(fs.readFileSync('supabase/schema.sql', 'utf8').replace(/^\uFEFF/, ''));
  await db.exec(fs.readFileSync('supabase/backup.sql', 'utf8').replace(/^\uFEFF/, ''));
});
after(async () => {if (db) await db.close();});
beforeEach(async () => {
  await db.exec(`reset role; truncate public.bookings, public.members cascade;
    insert into public.members(name,is_admin) values ('Admin',true), ('Alice',false), ('Bob',false);
    select public.set_pin('Admin','1234'); select public.set_pin('Alice','5678'); select public.set_pin('Bob','9012');`);
});

async function asAnon(sql, params = []) {
  await db.exec('set role anon');
  try {return await db.query(sql, params);} finally {await db.exec('reset role');}
}
async function booking(owner = 'Alice', pin = '5678', start = '2026-10-10', end = '2026-10-12') {
  const r = await asAnon('select (public.add_booking($1,$2,$3::date,$4::date,null)).id as id', [owner, pin, start, end]);
  return r.rows[0].id;
}

test('correct password verifies; wrong, null, and unknown identity do not', async () => {
  for (const [name, pin, expected] of [['Alice','5678',true],['Alice','bad',false],['Alice',null,false],['Nobody','5678',false]]) {
    assert.equal((await asAnon('select public.verify_pin($1,$2) as ok',[name,pin])).rows[0].ok, expected);
  }
});
test('first password setup works; short password and re-setting are rejected', async () => {
  await db.exec("insert into public.members(name) values ('New')");
  await assert.rejects(asAnon("select public.set_pin('New','abc')"), /at least 4/);
  await asAnon("select public.set_pin('New','abcd')");
  await assert.rejects(asAnon("select public.set_pin('New','xxxx')"), /already set/);
});
test('SECURITY: null password setup must not clear or leave an account unprotected', async () => {
  await db.exec("insert into public.members(name) values ('New')");
  await assert.rejects(asAnon("select public.set_pin('New',null)"), /Password|password/);
});
test('empty and overlong passwords cannot verify or mutate bookings', async () => {
  for (const pin of ['', 'x'.repeat(73)]) {
    assert.equal((await asAnon('select public.verify_pin(\'Alice\',$1) as ok',[pin])).rows[0].ok,false);
    await assert.rejects(booking('Alice',pin), /Incorrect password/);
  }
  await db.exec("insert into public.members(name) values ('New')");
  await assert.rejects(asAnon("select public.set_pin('New',repeat('x',73))"), /72 UTF-8 bytes/);
});
test('member creates and edits their booking; wrong password is rejected', async () => {
  const id = await booking();
  await assert.rejects(booking('Alice','bad','2026-11-01','2026-11-03'), /Incorrect password/);
  await asAnon('select public.update_booking($1,\'Alice\',\'5678\',\'2026-10-11\',\'2026-10-13\',\'edited\')',[id]);
  assert.equal((await db.query('select note from public.bookings where id=$1',[id])).rows[0].note, 'edited');
});
test('half-open database constraint accepts same-day changeover and rejects overlap', async () => {
  await booking();
  await booking('Bob','9012','2026-10-12','2026-10-14');
  await assert.rejects(booking('Bob','9012','2026-10-11','2026-10-13'), /overlap/);
});
test('database rejects zero/negative length and missing dates', async () => {
  await assert.rejects(booking('Alice','5678','2026-10-10','2026-10-10'));
  await assert.rejects(booking('Alice','5678','2026-10-12','2026-10-10'));
  await assert.rejects(booking('Alice','5678',null,'2026-10-10'));
});
test('members cannot edit/delete another member booking or book on behalf of others', async () => {
  const id = await booking();
  await assert.rejects(asAnon('select public.update_booking($1,\'Bob\',\'9012\',\'2026-10-10\',\'2026-10-12\',null)',[id]), /own bookings/);
  await assert.rejects(asAnon('select public.delete_booking($1,\'Bob\',\'9012\')',[id]), /own bookings/);
  await assert.rejects(asAnon("select public.add_booking_for_member('Bob','9012','Alice','2026-11-01','2026-11-03',null)"), /Only admins/);
});
test('admin can book for another member and edit/delete their booking', async () => {
  const result = await asAnon("select (public.add_booking_for_member('Admin','1234','Bob','2026-10-10','2026-10-12','admin note')).id as id");
  const id = result.rows[0].id;
  await asAnon('select public.update_booking($1,\'Admin\',\'1234\',\'2026-10-11\',\'2026-10-13\',null)',[id]);
  await asAnon('select public.delete_booking($1,\'Admin\',\'1234\')',[id]);
  assert.equal((await db.query('select count(*)::int as n from public.bookings')).rows[0].n, 0);
});
test('update cannot move a booking into an existing reservation', async () => {
  const id = await booking();
  await booking('Bob','9012','2026-10-14','2026-10-16');
  await assert.rejects(asAnon('select public.update_booking($1,\'Alice\',\'5678\',\'2026-10-13\',\'2026-10-15\',null)',[id]), /overlap/);
});
test('owner deletion works and missing booking reports an error', async () => {
  const id = await booking();
  await asAnon('select public.delete_booking($1,\'Alice\',\'5678\')',[id]);
  await assert.rejects(asAnon('select public.delete_booking($1,\'Alice\',\'5678\')',[id]), /not found/);
});
test('SECURITY: null password cannot create a booking', async () => {
  await assert.rejects(booking('Alice',null), /Incorrect password/);
});
test('SECURITY: null admin password cannot create a booking for another member', async () => {
  await assert.rejects(asAnon("select public.add_booking_for_member('Admin',null,'Bob','2026-10-10','2026-10-12',null)"), /Incorrect password/);
});
test('SECURITY: null password cannot edit a booking', async () => {
  const id = await booking();
  await assert.rejects(asAnon('select public.update_booking($1,\'Alice\',null,\'2026-10-11\',\'2026-10-13\',null)',[id]), /Incorrect password/);
});
test('SECURITY: null password cannot delete a booking', async () => {
  const id = await booking();
  await assert.rejects(asAnon('select public.delete_booking($1,\'Alice\',null)',[id]), /Incorrect password/);
});
test('SECURITY: public users cannot read password hashes despite inherited grants', async () => {
  await assert.rejects(asAnon('select pin_hash from public.members'), /permission denied/);
});

test('member view uses caller permissions and only safe columns are public for both roles', async () => {
  const options = (await db.query("select reloptions from pg_class where oid='public.members_public'::regclass")).rows[0].reloptions;
  assert.ok(options.includes('security_invoker=true'));
  for (const role of ['anon','authenticated']) {
    await db.exec('set role '+role);
    try {
      assert.equal((await db.query('select * from public.members_public')).rows.length,3);
      assert.equal((await db.query('select id,name,is_admin,has_pin from public.members')).rows.length,3);
      await assert.rejects(db.query('select * from public.members'), /permission denied/);
      await assert.rejects(db.query('select pin_hash from public.members'), /permission denied/);
      await assert.rejects(db.query('update public.members set is_admin=true'), /permission denied/);
      await assert.rejects(db.query('update public.members_public set is_admin=true'), /permission denied/);
    } finally {await db.exec('reset role');}
  }
  // A restricted caller sees no rows, proving the view does not bypass RLS.
  await db.exec('create role restricted_reader; grant usage on schema public to restricted_reader; grant select(id,name,is_admin,has_pin) on public.members to restricted_reader; grant select on public.members_public to restricted_reader; set role restricted_reader');
  try {assert.equal((await db.query('select * from public.members_public')).rows.length,0);}
  finally {await db.exec('reset role');}
});

test('has_pin follows password setup and reset without exposing or accepting a stored password flag', async () => {
  await db.exec("insert into public.members(name) values ('New')");
  const hasPin = async () => (await asAnon("select has_pin from public.members_public where name='New'")).rows[0].has_pin;
  assert.equal(await hasPin(),false);
  await asAnon("select public.set_pin('New','abcd')");
  assert.equal(await hasPin(),true);
  await db.exec("update public.members set pin_hash=null where name='New'");
  assert.equal(await hasPin(),false);
  await assert.rejects(db.exec("update public.members set has_pin=true where name='New'"), /can only be updated to DEFAULT/);
});
test('temporary tables cannot shadow members inside privileged functions', async () => {
  await db.exec("create temporary table members (id uuid, name text, pin_hash text, is_admin boolean); insert into members values (gen_random_uuid(),'Alice',extensions.crypt('fake',extensions.gen_salt('bf')),true); grant all on members to anon;");
  try { await assert.rejects(booking('Alice','fake'), /Incorrect password/); }
  finally { await db.exec('drop table pg_temp.members'); }
});
test('SECURITY: public users cannot truncate bookings despite inherited grants', async () => {
  await booking();
  await assert.rejects(asAnon('truncate public.bookings'), /permission denied/);
});
test('RLS blocks direct insert, update and delete', async () => {
  const id = await booking();
  await assert.rejects(asAnon("insert into public.bookings(member_id,start_date,end_date) select id,'2026-11-01','2026-11-03' from public.members where name='Alice'"));
  await assert.rejects(asAnon('update public.bookings set note=\'bypassed\' where id=$1 returning id',[id]), /permission denied/);
  await assert.rejects(asAnon('delete from public.bookings where id=$1 returning id',[id]), /permission denied/);
});
test('public users cannot call backup export; backend can export and restore without losing identities', async () => {
  await booking();
  await assert.rejects(asAnon('select public.export_booking_backup()'), /permission denied/);
  await db.exec('set role service_role');
  let snapshot;
  try {snapshot = (await db.query('select public.export_booking_backup() as data')).rows[0].data;}
  finally {await db.exec('reset role');}
  assert.equal(snapshot.tables.members.length, 3);
  assert.equal(snapshot.tables.bookings.length, 1);
  assert.equal('during' in snapshot.tables.bookings[0], false);
  assert.ok(snapshot.tables.members.every(row => row.pin_hash));
  await db.exec('truncate public.bookings, public.members');
  for (const row of snapshot.tables.members) {
    await db.query('insert into public.members(id,name,pin_hash,is_admin) values ($1,$2,$3,$4)',[row.id,row.name,row.pin_hash,row.is_admin]);
  }
  for (const row of snapshot.tables.bookings) {
    await db.query('insert into public.bookings(id,member_id,start_date,end_date,note,created_at) values ($1,$2,$3,$4,$5,$6)',[row.id,row.member_id,row.start_date,row.end_date,row.note,row.created_at]);
  }
  assert.equal((await asAnon("select public.verify_pin('Alice','5678') as ok")).rows[0].ok, true);
  const saved = (await db.query('select id,member_id,start_date::text,end_date::text from public.bookings')).rows[0];
  for (const key of ['id','member_id','start_date','end_date']) assert.equal(saved[key], snapshot.tables.bookings[0][key]);
});
