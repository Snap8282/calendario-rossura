// Manually invoked real browser/database tests. Never imported by npm test or CI.
// Creates temporary test accounts using a secret key from an ignored local JSON file.
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const assert = require('node:assert/strict');
const {chromium, devices, expect} = require('@playwright/test');

const PROJECT = 'dpgsyjdoohegbpbzinff';
const SITE = 'https://snap8282.github.io/calendario-rossura/';
const marker = 'ROSSURA_AUTOTEST_' + randomUUID() + '_';
const report = {marker,started_at:new Date().toISOString(),checks:[],cleanup:null};
let config, api, browser, page, members, slot;
const owned = new Map();
const temporaryMembers = new Map();
let baseline;
const output = path.resolve('live-test-results',marker);
const addDays = (date,n) => new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const swiss = date => date.split('-').reverse().join('.');

function redact(message) {
  let text = String(message);
  const secrets=[config?.service_key,...(config?.accounts || []).map(account=>account.password)].filter(Boolean);
  for (const secret of secrets) {
    for (const variant of [secret,JSON.stringify(secret).slice(1,-1),encodeURIComponent(secret)]) text=text.split(variant).join('[REDACTED]');
  }
  return text;
}
async function check(name, action) {
  try {await action(); report.checks.push({name,status:'PASS'}); console.log('PASS '+name);}
  catch(error) {report.checks.push({name,status:'FAIL',error:redact(error.message)}); throw error;}
}
function accountFor(name) {
  const account = config.accounts.find(item=>item.name===name);
  assert.ok(account,'A configured account is required');
  return account;
}
async function rest(resource, method='GET', body) {
  const response = await fetch(api.url+'/rest/v1/'+resource, {
    method,headers:{apikey:api.key,Authorization:'Bearer '+api.key,'Content-Type':'application/json'},
    body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(20000),redirect:'error',
  });
  const text = await response.text();
  return {ok:response.ok,status:response.status,data:text ? JSON.parse(text) : null};
}
async function serviceRest(resource,method='GET',body) {
  const headers={apikey:config.service_key,'Content-Type':'application/json',Prefer:'return=representation'};
  // New sb_secret_ keys use apikey only; legacy service-role JWTs also use Bearer.
  if (!config.service_key.startsWith('sb_secret_')) headers.Authorization='Bearer '+config.service_key;
  const response=await fetch(api.url+'/rest/v1/'+resource,{method,headers,
    body:body ? JSON.stringify(body) : undefined,signal:AbortSignal.timeout(20000),redirect:'error'});
  const text=await response.text();
  return {ok:response.ok,status:response.status,data:text ? JSON.parse(text) : null};
}
async function allBookings() {
  const rows=[];
  for (;;) {
    const response=await rest('bookings?select=id,member_id,start_date,end_date,note&order=id&limit=500&offset='+rows.length);
    assert.ok(response.ok,'Booking inventory read failed');
    assert.ok(Array.isArray(response.data),'Invalid booking inventory');
    if (!response.data.length) return rows;
    rows.push(...response.data);
  }
}
async function booking(id) {
  const response=await rest('bookings?select=id,member_id,start_date,end_date,note&id=eq.'+encodeURIComponent(id));
  assert.ok(response.ok,'Booking verification read failed');
  return response.data[0];
}
async function guardMutation(rpc,args) {
  assert.ok(config.accounts.some(item=>item.name===(args.p_member_name || args.p_actor_member_name)), 'Unconfigured actor');
  if (rpc==='set_pin') {
    assert.ok([...temporaryMembers.values()].some(member=>member.name===args.p_member_name),'Password setup is restricted to temporary test accounts');
    assert.equal(args.p_pin,accountFor(args.p_member_name).password,'Unexpected test account password');
  } else if (rpc==='add_booking' || rpc==='add_booking_for_member') {
    assert.ok(typeof args.p_note==='string' && args.p_note.startsWith(marker),'Creation requires this run marker');
    assert.ok(args.p_start>=slot.start && args.p_end<=slot.end && args.p_start<args.p_end,'Creation must stay in the selected test slot');
    const target=args.p_target_member_name || args.p_member_name;
    accountFor(target);
  } else if (rpc==='update_booking' || rpc==='delete_booking') {
    assert.ok(owned.has(args.p_booking_id),'Refusing to mutate a booking not created by this run');
    const row=await booking(args.p_booking_id);
    assert.ok(row && row.note?.startsWith(marker) && row.member_id===owned.get(row.id),'Test booking identity/marker mismatch');
    if (rpc==='update_booking') {
      assert.ok(args.p_note?.startsWith(marker),'Updated note must preserve this run marker');
      assert.ok(args.p_start>=slot.start && args.p_end<=slot.end && args.p_start<args.p_end,'Update must stay in the selected test slot');
    }
  } else throw new Error('Refusing unexpected mutation '+rpc);
}
async function rpc(name,args) {
  if (name!=='verify_pin') await guardMutation(name,args);
  const response=await rest('rpc/'+name,'POST',args);
  if (response.ok && name.startsWith('add_booking') && response.data?.id) {
    owned.set(response.data.id,response.data.member_id);
  }
  return response;
}
async function login(account, wrong=false) {
  const member=members.find(item=>item.name===account.name);
  await page.locator('#gate-name').selectOption(member.id);
  await page.locator('#gate-password').fill(wrong ? randomUUID() : account.password);
  await page.locator('#gate-submit').click();
  if (wrong) {await expect(page.locator('#gate-error')).toHaveText('Password errata.'); return;}
  await expect(page.locator('#booking-status')).toContainText('Prenotazioni aggiornate');
}
async function activate(locator,mobile) {if (mobile) await locator.tap(); else await locator.click();}
const day = date => page.locator(`.fc-daygrid-day[data-date="${date}"]:not(.fc-day-other) .fc-daygrid-day-number`);
const strip = date => page.locator(`.fc-daygrid-day[data-date="${date}"]:not(.fc-day-other) .booking-strip.starts-here`);
async function selectDates(start,end,mobile) {
  await activate(day(start),mobile); await activate(day(end),mobile);
  await expect(page.locator('#booking-modal')).toBeVisible();
}
async function submitAndRead(rpcName,button,mobile) {
  const responsePromise=page.waitForResponse(response=>response.url()===api.url+'/rest/v1/rpc/'+rpcName && response.request().method()==='POST');
  await activate(page.locator(button),mobile);
  const response=await responsePromise;
  const body=await response.text();
  const data=body ? JSON.parse(body) : null;
  if (response.ok() && rpcName.startsWith('add_booking') && data?.id) owned.set(data.id,data.member_id);
  assert.ok(response.ok(),'Live '+rpcName+' failed');
  return data;
}
async function installGuard(context) {
  await context.route('**/*',async route=>{
    const request=route.request(), url=new URL(request.url());
    if (url.origin===new URL(api.url).origin && !['GET','HEAD','OPTIONS'].includes(request.method())) {
      const name=url.pathname.startsWith('/rest/v1/rpc/') ? url.pathname.slice('/rest/v1/rpc/'.length) : '';
      if (name!=='verify_pin') {
        try {assert.equal(request.method(),'POST'); await guardMutation(name,request.postDataJSON());}
        catch(error) {report.checks.push({name:'Mutation guard',status:'FAIL',error:redact(error.message)}); return route.abort();}
      }
    } else if (!['GET','HEAD','OPTIONS'].includes(request.method())) {
      report.checks.push({name:'Unexpected external write',status:'FAIL'}); return route.abort();
    }
    await route.continue();
  });
}
async function cleanup() {
  if (!api || !members) {report.cleanup={status:'NOT_NEEDED'}; return;}
  // Recover any committed creation whose browser response was lost.
  const rows=(await allBookings()).filter(row=>row.note?.startsWith(marker));
  const failures=[];
  for (const row of rows) {
    const member=members.find(item=>item.id===row.member_id);
    const actor=config.accounts.find(item=>item.name===member?.name)
      || config.accounts.find(item=>members.find(member=>member.name===item.name)?.is_admin);
    if (!actor) {failures.push(row.id); continue;}
    owned.set(row.id,row.member_id);
    try {
      const response=await rpc('delete_booking',{p_booking_id:row.id,p_member_name:actor.name,p_pin:actor.password});
      if (!response.ok || await booking(row.id)) failures.push(row.id);
    } catch {failures.push(row.id);}
  }
  const remaining=(await allBookings()).filter(row=>row.note?.startsWith(marker)).map(row=>row.id);
  const remainingMembers=[];
  for (const [id,expected] of temporaryMembers) {
    const found=await serviceRest('members?select=id,name,is_admin&id=eq.'+id);
    if (!found.ok) {remainingMembers.push(id); continue;}
    if (!found.data.length) continue;
    if (found.data[0].name!==expected.name || found.data[0].is_admin!==expected.is_admin
      || (await allBookings()).some(row=>row.member_id===id)) {remainingMembers.push(id); continue;}
    // IDs/names/roles must match, and no bookings may remain before the cascading FK delete.
    const removed=await serviceRest('members?id=eq.'+id+'&name=eq.'+encodeURIComponent(expected.name),'DELETE');
    const verify=await serviceRest('members?select=id&id=eq.'+id);
    if (!removed.ok || !verify.ok || verify.data.length) remainingMembers.push(id);
  }
  const unchanged=baseline ? JSON.stringify((await allBookings()).filter(row=>!row.note?.startsWith(marker)))===JSON.stringify(baseline) : true;
  report.cleanup={status:failures.length || remaining.length || remainingMembers.length || !unchanged ? 'FAIL' : 'PASS',
    remaining_ids:[...new Set([...failures,...remaining])],remaining_member_ids:remainingMembers,original_bookings_unchanged:unchanged};
  if (report.cleanup.status==='FAIL') throw new Error('Test records remain; inspect cleanup.remaining_ids in the report');
}
async function scenario(mobile) {
  const label=(members.find(member=>member.name===config.accounts[0].name)?.is_admin ? 'Admin ' : 'Member ')+(mobile ? 'mobile touch' : 'desktop');
  const context=await browser.newContext(mobile ? devices['Pixel 7'] : {viewport:{width:1280,height:900}});
  context.setDefaultTimeout(25000);
  await installGuard(context);
  page=await context.newPage();
  try {
    const actor=config.accounts[0];
    await page.goto(SITE,{waitUntil:'domcontentloaded'});
    await expect(page.locator('#gate-name option')).toHaveCount(members.length+1);
    await check(label+' wrong password rejected',()=>login(actor,true));
    await check(label+' login and booking inventory loaded',()=>login(actor));
    const bounds=await page.evaluate(()=>({start:visibleRange.start,end:visibleRange.end}));
    const rows=await allBookings();
    const today=new Date().toISOString().slice(0,10);
    let candidate=addDays(today,1);
    if (candidate<bounds.start) candidate=bounds.start;
    while (addDays(candidate,8)<bounds.end && rows.some(row=>candidate<row.end_date && row.start_date<addDays(candidate,8))) candidate=addDays(candidate,1);
    assert.ok(addDays(candidate,8)<bounds.end,'No free eight-day slot in the displayed calendar');
    slot={start:candidate,end:addDays(candidate,8)};
    const start=addDays(candidate,1), end=addDays(candidate,3), editedEnd=addDays(candidate,4);
    let record;
    await check(label+' creates a real booking',async()=>{
      await selectDates(start,end,mobile);
      await page.locator('#booking-note').fill(marker+label);
      record=await submitAndRead('add_booking','#booking-submit',mobile);
      await expect(page.locator('#booking-modal')).toBeHidden();
      const saved=await booking(record.id);
      assert.equal(saved.start_date,start); assert.equal(saved.end_date,end); assert.equal(saved.note,marker+label);
    });
    await check(label+' Swiss date display and real booking edit',async()=>{
      await activate(strip(start),mobile);
      await expect(page.locator('#event-dates')).toHaveText('Check-in: '+swiss(start)+'\nCheck-out: '+swiss(end));
      await activate(page.locator('#event-edit-btn'),mobile);
      await page.locator('#event-edit-end').fill(editedEnd);
      await page.locator('#event-edit-note').fill(marker+label+' edited');
      await submitAndRead('update_booking','#event-save-btn',mobile);
      await expect(page.locator('#event-modal')).toBeHidden();
      const saved=await booking(record.id);
      assert.equal(saved.end_date,editedEnd); assert.equal(saved.note,marker+label+' edited');
    });
    await check(label+' booking persists after page reload',async()=>{
      await page.reload({waitUntil:'domcontentloaded'}); await login(actor);
      await expect(strip(start)).toBeVisible();
    });
    await check(label+' invalid range warning, disabled booking and cancel',async()=>{
      await selectDates(candidate,end,mobile);
      await expect(page.locator('#booking-error')).toContainText('Queste date si sovrappongono');
      await expect(page.locator('#booking-submit')).toBeDisabled();
      await page.locator('#booking-start').fill(editedEnd);
      await page.locator('#booking-end').fill(addDays(candidate,6));
      await expect(page.locator('#booking-submit')).toBeEnabled();
      await expect(page.locator('#booking-error')).toBeHidden();
      await activate(page.locator('#booking-cancel'),mobile);
      await expect(page.locator('#booking-modal')).toBeHidden();
      await expect(page.locator('.pending-checkin, .pending-checkout, .pending-between')).toHaveCount(0);
    });
    await check(label+' real backend rejects null passwords and overlaps',async()=>{
      const args={p_member_name:actor.name,p_pin:null,p_start:start,p_end:end,p_note:marker+' rejected'};
      assert.equal((await rpc('add_booking',args)).ok,false);
      assert.equal((await rpc('add_booking',{...args,p_pin:actor.password})).ok,false);
      assert.equal((await allBookings()).filter(row=>row.note?.startsWith(marker)).length,1);
    });
    const other=config.accounts.find(item=>item.name!==actor.name && !members.find(member=>member.name===item.name)?.is_admin);
    if (other && members.find(member=>member.name===actor.name)?.is_admin) await check(label+' admin books, edits and deletes for another member',async()=>{
      const target=members.find(member=>member.name===other.name);
      const targetStart=editedEnd, targetEnd=addDays(candidate,6);
      await selectDates(targetStart,targetEnd,mobile);
      await page.locator('#booking-member').selectOption(target.id);
      await page.locator('#booking-note').fill(marker+label+' admin for member');
      const created=await submitAndRead('add_booking_for_member','#booking-submit',mobile);
      await expect(page.locator('#booking-modal')).toBeHidden();
      assert.equal((await booking(created.id)).member_id,target.id);
      await activate(strip(targetStart),mobile); await activate(page.locator('#event-edit-btn'),mobile);
      await page.locator('#event-edit-note').fill(marker+label+' admin edited member');
      await submitAndRead('update_booking','#event-save-btn',mobile);
      await expect(page.locator('#event-modal')).toBeHidden();
      assert.equal((await booking(created.id)).note,marker+label+' admin edited member');
      await activate(strip(targetStart),mobile); page.once('dialog',dialog=>dialog.accept());
      await submitAndRead('delete_booking','#event-delete-btn',mobile);
      await expect(page.locator('#event-modal')).toBeHidden(); assert.equal(await booking(created.id),undefined);
    });
    if (other) await check(label+' another member cannot edit or delete the test booking',async()=>{
      await page.getByRole('button',{name:'Esci',exact:true}).click(); await login(other);
      await activate(strip(start),mobile);
      await expect(page.locator('#event-edit-btn')).toBeHidden(); await expect(page.locator('#event-delete-btn')).toBeHidden();
      const saved=await booking(record.id);
      assert.equal((await rpc('update_booking',{p_booking_id:record.id,p_member_name:other.name,p_pin:other.password,p_start:start,p_end:editedEnd,p_note:marker+' unauthorized'})).ok,false);
      assert.equal((await rpc('delete_booking',{p_booking_id:record.id,p_member_name:other.name,p_pin:other.password})).ok,false);
      assert.deepEqual(await booking(record.id),saved);
      await page.locator('#event-close-btn').click(); await page.getByRole('button',{name:'Esci',exact:true}).click(); await login(actor);
    });
    await check(label+' deletes the real test booking and logs out',async()=>{
      await activate(strip(start),mobile);
      const beforeCancel=await booking(record.id);
      page.once('dialog',dialog=>dialog.dismiss());
      await activate(page.locator('#event-delete-btn'),mobile);
      await expect(page.locator('#event-modal')).toBeVisible();
      assert.deepEqual(await booking(record.id),beforeCancel,'Cancelling deletion must keep the record');
      page.once('dialog',dialog=>dialog.accept());
      await submitAndRead('delete_booking','#event-delete-btn',mobile);
      await expect(page.locator('#event-modal')).toBeHidden();
      assert.equal(await booking(record.id),undefined);
      await page.getByRole('button',{name:'Esci',exact:true}).click(); await expect(page.locator('#login-gate')).toBeVisible();
    });
  } catch(error) {
    try {await page.screenshot({path:path.join(output,label.replace(/ /g,'-')+'-failure.png')});} catch {}
    throw error;
  } finally {await context.close();}
}

(async()=>{
  try {
    assert.ok(process.argv[2],'Pass the local credential JSON path explicitly');
    try {config=JSON.parse(fs.readFileSync(process.argv[2],'utf8').replace(/^\uFEFF/,''));}
    catch {throw new Error('Cannot read a valid local credential JSON file; check the file locally');}
    assert.ok(config.site_url===SITE,'This runner is pinned to the Rossura published site');
    assert.ok(config.project_ref===PROJECT,'This runner is pinned to the Rossura test-phase database');
    assert.ok(typeof config.service_key==='string' && config.service_key.length>20 && !config.service_key.includes('ENTER_SUPABASE'),'Fill the Supabase secret key locally first');
    const suffix=marker.slice('ROSSURA_AUTOTEST_'.length,'ROSSURA_AUTOTEST_'.length+8);
    config.accounts=[{name:'Autotest Admin '+suffix,password:randomUUID()},
      {name:'Autotest Member A '+suffix,password:randomUUID()}, {name:'Autotest Member B '+suffix,password:randomUUID()}];
    assert.equal(new Set(config.accounts.map(item=>item.name)).size,config.accounts.length,'Duplicate account names');
    assert.ok(config.accounts.every(item=>typeof item.name==='string' && typeof item.password==='string' && item.password.length>=4 && !item.password.includes('ENTER_EXISTING')),'Fill existing account passwords locally first');
    fs.mkdirSync(output,{recursive:true});
    browser=await chromium.launch();
    const discovery=await browser.newPage();
    await discovery.goto(SITE,{waitUntil:'domcontentloaded'});
    api=await discovery.evaluate(()=>({url:SUPABASE_URL,key:SUPABASE_ANON_KEY}));
    assert.equal(api.url,'https://'+PROJECT+'.supabase.co','Published site targets a different database');
    assert.equal(await discovery.evaluate(()=>typeof updateBookingValidation),'function','Published app is missing the latest invalid-range fix');
    await discovery.close();
    baseline=await allBookings();
    const initialMembers=await rest('members_public?select=id,name,is_admin,has_pin');
    assert.ok(initialMembers.ok && Array.isArray(initialMembers.data),'Member inventory read failed');
    members=initialMembers.data;
    const rows=config.accounts.map((account,index)=>({id:randomUUID(),name:account.name,is_admin:index===0,pin_hash:null}));
    for (const row of rows) temporaryMembers.set(row.id,{name:row.name,is_admin:row.is_admin});
    const inserted=await serviceRest('members','POST',rows);
    assert.ok(inserted.ok,'Cannot create temporary test members with the provided secret key');
    const response=await rest('members_public?select=id,name,is_admin,has_pin');
    assert.ok(response.ok,'Member lookup failed'); members=response.data;
    const setupContext=await browser.newContext(); await installGuard(setupContext); page=await setupContext.newPage();
    try {
      await page.goto(SITE,{waitUntil:'domcontentloaded'});
      for (const account of config.accounts) await check('First password setup: '+account.name,async()=>{
        const member=members.find(item=>item.name===account.name);
        assert.ok(member && !member.has_pin,'Temporary account should begin without a password');
        await page.locator('#gate-name').selectOption(member.id);
        await page.locator('#gate-new-password-input').fill(account.password);
        await page.locator('#gate-new-password-confirm').fill(account.password);
        await page.locator('#gate-set-password-submit').click();
        await expect(page.locator('#booking-status')).toContainText('Prenotazioni aggiornate');
        await page.getByRole('button',{name:'Esci',exact:true}).click();
      });
    } finally {await setupContext.close();}
    members=(await rest('members_public?select=id,name,is_admin,has_pin')).data;
    for (const account of config.accounts) {
      assert.ok(members.some(item=>item.name===account.name && item.has_pin),'Configured account does not have an existing password');
      const verification=await rpc('verify_pin',{p_member_name:account.name,p_pin:account.password});
      assert.ok(verification.ok && verification.data===true,'Configured account password did not verify');
    }
    await scenario(false); await scenario(true);
    await check('Public password-hash reads are blocked',async()=>{
      const response=await rest('members?select=pin_hash&limit=1','HEAD');
      assert.ok([401,403].includes(response.status),'Public password-hash access must be denied');
    });
    await check('Simultaneous overlapping member bookings: exactly one succeeds',async()=>{
      const actors=config.accounts.filter(account=>!members.find(member=>member.name===account.name)?.is_admin);
      const results=await Promise.all(actors.map((actor,index)=>rpc('add_booking',{
        p_member_name:actor.name,p_pin:actor.password,p_start:slot.start,p_end:addDays(slot.start,2),p_note:marker+' concurrency '+index,
      })));
      assert.equal(results.filter(result=>result.ok).length,1,'Exactly one overlapping write should succeed');
      assert.ok(results.find(result=>!result.ok).data?.message?.includes('overlap'),'The loser should fail because of overlap');
      const winner=results.findIndex(result=>result.ok);
      const deleted=await rpc('delete_booking',{p_booking_id:results[winner].data.id,p_member_name:actors[winner].name,p_pin:actors[winner].password});
      assert.ok(deleted.ok && !await booking(results[winner].data.id),'Concurrency fixture should be removed');
    });
    // Repeat the full create/edit/delete flow as an ordinary member, not just an admin.
    [config.accounts[0],config.accounts[1]]=[config.accounts[1],config.accounts[0]];
    await scenario(false); await scenario(true);
  } catch(error) {report.error=redact(error.message); console.error(report.error); process.exitCode=1;}
  finally {
    try {await cleanup();} catch(error) {report.cleanup ||= {status:'FAIL'}; report.cleanup.error=redact(error.message); console.error(report.cleanup.error); process.exitCode=1;}
    if (browser) await browser.close();
    report.finished_at=new Date().toISOString();
    if (fs.existsSync(output)) {fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)); console.log('Report: '+path.join(output,'report.json'));}
    if (report.cleanup) console.log('Cleanup: '+report.cleanup.status);
  }
})();
