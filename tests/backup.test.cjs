const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function validSnapshot() {
  return {format_version: 1, snapshot_at: '2026-10-10T00:00:00Z', tables: {
    members: [{id: '00000000-0000-0000-0000-000000000001', name: 'Alice', is_admin: false, pin_hash: 'test-hash'}],
    bookings: [{id: '00000000-0000-0000-0000-000000000002', member_id: '00000000-0000-0000-0000-000000000001', start_date: '2026-10-10', end_date: '2026-10-12', note: 'Test', created_at: '2026-10-10T00:00:00Z'}]
  }};
}
function harness({snapshot = validSnapshot(), status = 200, corruptFile = false, busy = false} = {}) {
  const props = {SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test', BACKUP_FOLDER_ID: 'folder'};
  const files = [];
  let released = false;
  const context = vm.createContext({
    PropertiesService: {getScriptProperties: () => ({getProperty: key => props[key], setProperty: (key,value) => {props[key] = value;}, setProperties: values => Object.assign(props, values), deleteProperty: key => {delete props[key];}})},
    LockService: {getScriptLock: () => ({tryLock: () => !busy, releaseLock: () => {released = true;}})},
    UrlFetchApp: {fetch: () => ({getResponseCode: () => status, getContentText: () => JSON.stringify(snapshot)})},
    Utilities: {formatDate: () => '2026-10-10T03-00-00', getUuid: () => 'abc-123', newBlob: data => ({data})},
    DriveApp: {getFolderById: () => ({createFile: blob => {
      const file = {getId: () => 'saved', getUrl: () => 'https://drive.google.com/test', getBlob: () => ({getDataAsString: () => corruptFile ? 'corrupt' : blob.data})};
      files.push(file); return file;
    }, getFiles: () => ({hasNext: () => false})})},
    console: {log() {}}
  });
  vm.runInContext(fs.readFileSync('backup/Code.gs','utf8'), context);
  return {context, props, files, released: () => released};
}
test('backup saves complete JSON and marks verified file successful', () => {
  const h = harness(); h.context.runDailyBackup();
  const saved = JSON.parse(h.files[0].getBlob().getDataAsString());
  assert.equal(saved.tables.members[0].pin_hash, 'test-hash');
  assert.equal(saved.tables.bookings[0].note, 'Test');
  assert.equal(h.props.LAST_BACKUP_FILE_ID, 'saved');
  assert.deepEqual(JSON.parse(h.props.LAST_BACKUP_COUNTS), {members:1, bookings:1});
  assert.equal(h.released(), true);
});
test('failed HTTP request leaves previous success intact and releases lock', () => {
  const h = harness({status:503}); h.props.LAST_BACKUP_FILE_ID='previous';
  assert.throws(() => h.context.runDailyBackup(), /HTTP 503/);
  assert.equal(h.files.length,0); assert.equal(h.props.LAST_BACKUP_FILE_ID,'previous'); assert.equal(h.released(),true);
});
test('missing backup format is rejected before saving', () => {
  const h = harness({snapshot:{}});
  assert.throws(() => h.context.runDailyBackup(), /format/);
  assert.equal(h.files.length,0); assert.equal(h.props.LAST_BACKUP_AT,undefined);
});
test('corrupt Drive readback does not mark backup successful', () => {
  const h = harness({corruptFile:true});
  assert.throws(() => h.context.runDailyBackup(), /verification/);
  assert.equal(h.props.LAST_BACKUP_AT,undefined); assert.equal(h.released(),true);
});
test('overlapping backup run fails without fetching or saving', () => {
  const h = harness({busy:true});
  assert.throws(() => h.context.runDailyBackup(), /running/); assert.equal(h.files.length,0);
});
test('validator rejects duplicate identifiers and missing foreign key', () => {
  const h = harness(); const data=validSnapshot();
  data.tables.members.push({...data.tables.members[0]});
  assert.throws(() => h.context.validateBackup_(data), /member/);
  data.tables.members.pop(); data.tables.bookings[0].member_id='missing';
  assert.throws(() => h.context.validateBackup_(data), /booking/);
});
test('RECOVERY: validator must reject snapshots missing required restore fields', () => {
  const h=harness(); const data=validSnapshot(); delete data.tables.members[0].name;
  assert.throws(() => h.context.validateBackup_(data), /member/);
});
test('health check accepts empty healthy table and only records success', () => {
  const h=harness({snapshot:[]}); h.context.runHealthCheck(); assert.ok(h.props.LAST_HEALTH_CHECK_AT);
  const failed=harness({status:500}); assert.throws(() => failed.context.runHealthCheck(), /HTTP 500/);
  assert.equal(failed.props.LAST_HEALTH_CHECK_AT,undefined);
});
test('retention keeps two newest, recent copies and unrelated files', () => {
  const h=harness(); const removed=[];
  function file(id,days,name) {return {getId:()=>id,getName:()=>name || `rossura-backup-2026-01-01T03-00-00-${id}.json`,getDateCreated:()=>new Date(Date.now()-days*86400000),setTrashed:()=>removed.push(id)};}
  const files=[file('aaa',1),file('bbb',10),file('ccc',29),file('ddd',31),file('eee',100,'unrelated.json')];
  let index=0; h.context.expireBackups_({getFiles:()=>({hasNext:()=>index<files.length,next:()=>files[index++]})},'aaa');
  assert.deepEqual(removed,['ddd']);
  removed.length=0; index=0;
  files.splice(0,files.length,file('aaa',60),file('bbb',70),file('ccc',80));
  h.context.expireBackups_({getFiles:()=>({hasNext:()=>index<files.length,next:()=>files[index++]})},'aaa');
  assert.deepEqual(removed,['ccc']);
});

test('validator rejects malformed dates, timestamps, identifiers, types and overlaps', () => {
  const h=harness();
  for (const mutate of [
    data=>{data.tables.bookings[0].start_date='2026-02-30';},
    data=>{data.tables.bookings[0].end_date='2026-10-09';},
    data=>{data.tables.bookings[0].created_at='bad';},
    data=>{data.tables.members[0].id='not-a-uuid';},
    data=>{data.tables.members[0].is_admin='false';},
    data=>{data.tables.bookings.push({...data.tables.bookings[0],id:'00000000-0000-0000-0000-000000000003'});},
    data=>{data.snapshot_at='yesterday';},
    data=>{data.schema_version=999;}
  ]) {const data=validSnapshot(); mutate(data); assert.throws(()=>h.context.validateBackup_(data));}
});
test('large row-count drop preserves previous backups until warning is explicitly cleared', () => {
  const h=harness(); h.props.LAST_BACKUP_COUNTS=JSON.stringify({members:10,bookings:10});
  h.context.runDailyBackup();
  assert.ok(h.props.RETENTION_WARNING); assert.ok(h.props.LAST_BACKUP_AT);
});
test('independent health check detects an overdue daily backup', () => {
  const h=harness({snapshot:[]}); h.props.LAST_BACKUP_AT=new Date(Date.now()-40*3600000).toISOString();
  assert.throws(()=>h.context.runHealthCheck(), /older than 36 hours/);
  assert.ok(h.props.LAST_HEALTH_CHECK_AT);
});
