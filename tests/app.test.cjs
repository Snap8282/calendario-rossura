const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Minimal DOM for testing domain functions; actual browser flows are in e2e/.
function app() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {value: '', textContent: '', innerHTML: '',
      classList: {add() {}, remove() {}, toggle() {}, contains() {return true;}},
      addEventListener() {}, append() {}, appendChild() {}, querySelectorAll() {return [];}});
    return nodes.get(id);
  }
  const context = vm.createContext({
    SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test',
    supabase: {createClient: () => ({from: () => ({select: () => ({order: async () => ({data: [], error: null})})})})},
    document: {getElementById: node, addEventListener() {}, createElement: () => node(Math.random())},
    window: {addEventListener() {}}, AbortController,
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {}, setInterval: () => 1, console,
  });
  vm.runInContext(fs.readFileSync('app.js', 'utf8'), context);
  return {context, node, run: code => vm.runInContext(code, context)};
}

test('overlap allows adjoining check-out/check-in and rejects actual shared nights', () => {
  const {context: c} = app();
  assert.equal(c.rangesOverlap('2026-10-10', '2026-10-12', '2026-10-12', '2026-10-14'), false);
  assert.equal(c.rangesOverlap('2026-10-10', '2026-10-12', '2026-10-11', '2026-10-14'), true);
  assert.equal(c.rangesOverlap('2026-10-10', '2026-10-20', '2026-10-12', '2026-10-14'), true);
  assert.equal(c.rangesOverlap('2026-12-31', '2027-01-02', '2027-01-01', '2027-01-03'), true);
});

test('check-in is allowed on check-out day; display includes both changeover bookings', () => {
  const {context: c, run} = app();
  run(`bookingsCache = [
    {id:'a', start_date:'2026-10-10', end_date:'2026-10-12'},
    {id:'b', start_date:'2026-10-12', end_date:'2026-10-14'}
  ]`);
  assert.equal(c.isSelectableCheckin('2026-10-11'), false);
  assert.equal(c.isSelectableCheckin('2026-10-14'), true);
  assert.equal(c.bookingsForDate('2026-10-12').length, 2);
});

test('date validation rejects missing, same-day, and reversed ranges', () => {
  const {context: c} = app();
  assert.equal(c.validateBookingDates('', '2026-10-12', 'error'), false);
  assert.equal(c.validateBookingDates('2026-10-12', '2026-10-12', 'error'), false);
  assert.equal(c.validateBookingDates('2026-10-12', '2026-10-10', 'error'), false);
  assert.equal(c.validateBookingDates('2026-10-10', '2026-10-12', 'error'), true);
});

test('admins receive grey and non-admin colors are distinct for current family size', () => {
  const {context: c, run} = app();
  run(`members = [{id:'admin',name:'Admin',is_admin:true}, {id:'a',name:'A',is_admin:false}, {id:'b',name:'B',is_admin:false}];
    membersById = Object.fromEntries(members.map(m => [m.id,m]));`);
  assert.equal(c.colorForMember('admin'), '#6b7280');
  assert.notEqual(c.colorForMember('a'), c.colorForMember('b'));
});

function bookingLoader(h, fetchPage) {
  h.context.fetchPage = fetchPage;
  h.run(`identity = {name:'Alice',pin:'test'}; calendar = {}; visibleRange = {start:'2026-01-01',end:'2027-01-01'};
    sb.from = () => {const chain = {select:()=>chain,lte:()=>chain,gte:()=>chain,order:()=>chain,abortSignal:()=>chain,range:fetchPage}; return chain;};`);
}
test('booking pagination continues with actual row counts when server cap is smaller than requested', async () => {
  const h=app(), offsets=[];
  bookingLoader(h, async offset => {
    offsets.push(offset);
    return {data:offset===0 ? [{id:'a'},{id:'b'}] : offset===2 ? [{id:'c'}] : [],error:null};
  });
  assert.equal(await h.context.loadBookings(),true);
  assert.deepEqual(offsets,[0,2,3]);
  assert.equal(h.run('bookingsCache.length'),3);
  assert.equal(h.run('bookingsReady'),true);
});
test('failed later page keeps previous complete cache and blocks selection', async () => {
  const h=app();
  bookingLoader(h, async offset=>offset===0 ? {data:[{id:'new'}],error:null} : {data:null,error:{message:'offline'}});
  h.run("bookingsCache = [{id:'previous'}]");
  assert.equal(await h.context.loadBookings(),false);
  assert.equal(h.run('bookingsCache[0].id'),'previous');
  assert.equal(h.run('bookingsReady'),false);
  assert.match(h.node('booking-status').textContent,/Impossibile/);
});
test('a late booking response cannot replace a newer successful refresh', async () => {
  const h=app(); let release; let calls=0;
  bookingLoader(h,offset=>{
    if (calls++===0) return new Promise(resolve=>{release=resolve;});
    return Promise.resolve({data:offset===0 ? [{id:'newer'}] : [],error:null});
  });
  const old=h.context.loadBookings();
  assert.equal(await h.context.loadBookings(),true);
  release({data:[{id:'old'}],error:null});
  assert.equal(await old,false); assert.equal(h.run('bookingsCache[0].id'),'newer');
});
test('duplicate async actions are ignored and busy controls are released', async () => {
  const h=app(); let release; let calls=0;
  const first=h.context.runAction('login','gate-error',()=>{calls++; return new Promise(resolve=>{release=resolve;});});
  assert.equal(h.node('gate-submit').disabled,true);
  await h.context.runAction('login','gate-error',()=>{calls++;});
  assert.equal(calls,1); release(); await first;
  assert.equal(h.node('gate-submit').disabled,false);
});
test('session changes invalidate late responses from async actions', async () => {
  const h=app(); let release; let applied=false;
  const pending=h.context.runAction('login','gate-error',async current=>{
    await new Promise(resolve=>{release=resolve;}); if(current()) applied=true;
  });
  h.run('sessionVersion++'); release(); await pending; assert.equal(applied,false);
});
