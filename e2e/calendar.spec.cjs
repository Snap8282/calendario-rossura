const {test, expect} = require('@playwright/test');

test.beforeEach(async ({page}) => {
  await page.clock.setFixedTime(new Date('2026-10-10T10:00:00Z'));
  const members=[{id:'admin',name:'Admin',is_admin:true,has_pin:true},
    {id:'alice',name:'Alice',is_admin:false,has_pin:true},
    {id:'bob',name:'Bob',is_admin:false,has_pin:true},
    {id:'new',name:'New',is_admin:false,has_pin:false}];
  let bookings=[{id:'existing',member_id:'alice',start_date:'2026-10-10',end_date:'2026-10-12',note:'Original note'}];
  // All Supabase requests are intercepted; unknown external requests are blocked.
  await page.route('**/*', async route => {
    const url=new URL(route.request().url());
    if (url.hostname==='127.0.0.1') return route.continue();
    if (url.hostname!=='test.supabase.co') return route.abort();
    const path=url.pathname;
    const body=route.request().postDataJSON();
    let result;
    if (path.endsWith('/members_public')) result=members;
    else if (path.endsWith('/bookings')) {
      const offset=Number(url.searchParams.get('offset') || 0);
      const limit=Number(url.searchParams.get('limit') || 500);
      result=bookings.slice(offset,offset+limit);
    }
    else if (path.endsWith('/verify_pin')) result=body.p_pin==='correct';
    else if (path.endsWith('/set_pin')) result=null;
    else if (path.endsWith('/add_booking') || path.endsWith('/add_booking_for_member')) {
      const member=members.find(m => m.name===(body.p_target_member_name || body.p_member_name));
      const row={id:'created',member_id:member.id,start_date:body.p_start,end_date:body.p_end,note:body.p_note};
      bookings.push(row); result=row;
    } else if (path.endsWith('/update_booking')) {
      result=bookings.find(b=>b.id===body.p_booking_id);
      Object.assign(result,{start_date:body.p_start,end_date:body.p_end,note:body.p_note});
    } else if (path.endsWith('/delete_booking')) {
      bookings=bookings.filter(b=>b.id!==body.p_booking_id); result=null;
    } else throw new Error('Unmocked request '+path);
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto('/');
  await expect(page.locator('#gate-name option')).toHaveCount(5);
});
async function login(page,name='alice') {
  await page.locator('#gate-name').selectOption(name);
  await page.locator('#gate-password').fill('correct');
  await page.locator('#gate-submit').click();
  await expect(page.locator('#calendar')).toBeVisible();
  await expect(page.locator('.booking-strip')).toHaveCount(3);
}
async function selectDates(page,start='2026-10-15',end='2026-10-17') {
  await page.locator(`.fc-daygrid-day[data-date="${start}"]:not(.fc-day-other)`).click();
  await page.locator(`.fc-daygrid-day[data-date="${end}"]:not(.fc-day-other)`).click();
  await expect(page.locator('#booking-modal')).toBeVisible();
}
test('wrong password stays at login; correct password opens calendar; logout resets identity', async ({page}) => {
  await page.locator('#gate-name').selectOption('alice');
  await page.locator('#gate-password').fill('wrong'); await page.locator('#gate-submit').click();
  await expect(page.locator('#gate-error')).toHaveText('Password errata.');
  await expect(page.locator('#calendar')).toBeHidden();
  await login(page); await page.getByRole('button',{name:'Esci',exact:true}).click();
  await expect(page.locator('#login-gate')).toBeVisible(); await expect(page.locator('#gate-password')).toHaveValue('');
});
test('first-use password validates confirmation and signs in', async ({page}) => {
  await page.locator('#gate-name').selectOption('new');
  await page.locator('#gate-new-password-input').fill('abcd'); await page.locator('#gate-new-password-confirm').fill('different');
  await page.locator('#gate-set-password-submit').click(); await expect(page.locator('#gate-set-password-error')).toHaveText('Le password non coincidono.');
  await page.locator('#gate-new-password-confirm').fill('abcd'); await page.locator('#gate-set-password-submit').click();
  await expect(page.locator('#calendar')).toBeVisible();
});
test('member creates a booking with two date clicks and correct RPC arguments', async ({page}) => {
  await login(page); await selectDates(page); await page.locator('#booking-note').fill('Holiday');
  const call=page.waitForRequest(r=>r.url().endsWith('/rpc/add_booking'));
  await page.locator('#booking-submit').click();
  expect((await call).postDataJSON()).toEqual({p_member_name:'Alice',p_pin:'correct',p_start:'2026-10-15',p_end:'2026-10-17',p_note:'Holiday'});
  await expect(page.locator('.booking-strip')).toHaveCount(6);
});
test('checkout day is available; occupied night is rejected', async ({page}) => {
  await login(page);
  await page.locator('.fc-daygrid-day[data-date="2026-10-11"]:not(.fc-day-other) .fc-daygrid-day-number').click();
  await expect(page.locator('#error-banner')).toContainText('gia occupato');
  await selectDates(page,'2026-10-12','2026-10-14');
  await expect(page.locator('#booking-start')).toHaveValue('2026-10-12');
});
test('admin creates on behalf of another member', async ({page}) => {
  await expect(page.locator('#gate-name option').last()).toHaveText('Admin');
  await login(page,'admin'); await selectDates(page); await page.locator('#booking-member').selectOption('bob');
  await expect(page.locator('#booking-member option').last()).toHaveText('Admin');
  const call=page.waitForRequest(r=>r.url().endsWith('/rpc/add_booking_for_member'));
  await page.locator('#booking-submit').click();
  expect((await call).postDataJSON().p_target_member_name).toBe('Bob');
  await expect(page.locator('.booking-strip')).toHaveCount(6);
});
test('owner edits and deletes a reservation', async ({page}) => {
  await login(page); await page.locator('.booking-strip.starts-here').click();
  expect(await page.locator('#event-dates').innerText()).toBe('Check-in: 10.10.2026\nCheck-out: 12.10.2026');
  await expect(page.locator('#event-note')).toHaveText('Original note');
  await page.locator('#event-edit-btn').click(); await page.locator('#event-edit-note').fill('Updated note');
  await page.locator('#event-save-btn').click(); await expect(page.locator('#event-modal')).toBeHidden();
  await page.locator('.booking-strip.starts-here').click(); await expect(page.locator('#event-note')).toHaveText('Updated note');
  await page.locator('#event-edit-btn').click(); await page.locator('#event-edit-note').fill('');
  await page.locator('#event-save-btn').click(); await expect(page.locator('#event-modal')).toBeHidden();
  await page.locator('.booking-strip.starts-here').click(); await expect(page.locator('#event-note')).toBeHidden();
  await expect(page.locator('#event-note')).toHaveText('');
  page.once('dialog',dialog=>dialog.accept()); await page.locator('#event-delete-btn').click();
  await expect(page.locator('.booking-strip')).toHaveCount(0);
});
test('another member can view but cannot manage a reservation', async ({page}) => {
  await login(page,'bob'); await page.locator('.booking-strip.starts-here').click();
  await expect(page.locator('#event-edit-btn')).toBeHidden(); await expect(page.locator('#event-delete-btn')).toBeHidden();
});
test('SESSION: logout closes any open booking details modal', async ({page}) => {
  await login(page); await page.locator('.booking-strip.starts-here').click();
  // Invoke the same handler as the logout button; overlay otherwise blocks that button.
  await page.evaluate(()=>logout());
  await expect(page.locator('#login-gate')).toBeVisible();
  await expect(page.locator('#event-modal')).toBeHidden();
});

test('failed booking load displays a persistent warning and blocks date selection; retry recovers', async ({page}) => {
  await page.route('https://test.supabase.co/rest/v1/bookings?**',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'read failed'})}));
  await page.locator('#gate-name').selectOption('alice'); await page.locator('#gate-password').fill('correct'); await page.locator('#gate-submit').click();
  await expect(page.locator('#booking-status')).toContainText('Impossibile aggiornare');
  await page.locator('.fc-daygrid-day[data-date="2026-10-15"]:not(.fc-day-other)').click();
  await expect(page.locator('#booking-modal')).toBeHidden();
  await page.unroute('https://test.supabase.co/rest/v1/bookings?**');
  await page.locator('#refresh-bookings').click();
  await expect(page.locator('#booking-status')).toContainText('Prenotazioni aggiornate');
  await selectDates(page);
});
test('slow booking load cannot repopulate cache after logout', async ({page}) => {
  let release; const held=new Promise(resolve=>{release=resolve;});
  await page.route('https://test.supabase.co/rest/v1/bookings?**',async route=>{
    await held; await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify([{id:'late',member_id:'alice',start_date:'2026-10-10',end_date:'2026-10-12'}])});
  });
  const requested=page.waitForRequest(r=>r.url().includes('/rest/v1/bookings?'));
  await page.locator('#gate-name').selectOption('alice'); await page.locator('#gate-password').fill('correct'); await page.locator('#gate-submit').click();
  await requested; await expect(page.locator('#booking-status')).toContainText('Aggiornamento');
  const cancelled=page.waitForEvent('requestfailed',r=>r.url().includes('/rest/v1/bookings?'));
  await page.getByRole('button',{name:'Esci',exact:true}).click();
  await cancelled; release();
  await expect(page.locator('#login-gate')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>bookingsCache.length)).toBe(0);
  await expect(page.locator('#calendar-controls')).toBeHidden();
});
test('Enter logs in; Escape dismisses a dialog and returns focus', async ({page}) => {
  await page.locator('#gate-name').selectOption('alice'); await page.locator('#gate-password').fill('correct');
  await page.locator('#gate-password').press('Enter'); await expect(page.locator('.booking-strip')).toHaveCount(3);
  await page.locator('.booking-strip.starts-here').focus(); await page.locator('.booking-strip.starts-here').press('Enter');
  await expect(page.locator('#event-modal')).toBeVisible(); await expect(page.locator('#event-close-btn')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#event-edit-btn')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.locator('#event-close-btn')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.locator('#event-modal')).toBeHidden();
  await expect(page.locator('.booking-strip.starts-here')).toBeFocused();
});
test('failed create re-enables form controls and preserves entered fields', async ({page}) => {
  await login(page); await selectDates(page); await page.locator('#booking-note').fill('Keep this');
  await page.route('**/rpc/add_booking',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({message:'Those dates overlap with an existing booking'})}));
  await page.locator('#booking-submit').click(); await expect(page.locator('#booking-error')).toContainText('Queste date si sovrappongono a una prenotazione esistente.');
  await expect(page.locator('#booking-submit')).toBeEnabled(); await expect(page.locator('#booking-note')).toHaveValue('Keep this');
});

test.describe('mobile date selection', () => {
  test.use({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  test('overlapping dates open a cancellable dialog and booking waits for valid dates', async ({page}) => {
    await login(page);
    let writes = 0;
    page.on('request', request => {if (request.url().includes('/rpc/add_booking')) writes++;});
    const day = date => page.locator(`.fc-daygrid-day[data-date="${date}"]:not(.fc-day-other) .fc-daygrid-day-number`);
    await day('2026-10-09').tap();
    await day('2026-10-13').tap();
    await expect(page.locator('#booking-modal')).toBeVisible();
    await expect(page.locator('#booking-start')).toHaveValue('2026-10-09');
    await expect(page.locator('#booking-end')).toHaveValue('2026-10-13');
    await expect(page.locator('#booking-error')).toContainText('Queste date si sovrappongono');
    await expect(page.locator('#booking-submit')).toBeDisabled();
    await page.locator('#booking-start').press('Enter');
    expect(writes).toBe(0);
    await page.locator('#booking-cancel').tap();
    await expect(page.locator('#booking-modal')).toBeHidden();
    await expect(page.locator('.pending-checkin, .pending-checkout, .pending-between')).toHaveCount(0);
    await day('2026-10-09').tap();
    await day('2026-10-13').tap();
    // Checkout of the existing booking is a valid new check-in.
    await page.locator('#booking-start').fill('2026-10-12');
    await expect(page.locator('#booking-error')).toBeHidden();
    await expect(page.locator('#booking-submit')).toBeEnabled();
    await page.locator('#booking-end').fill('2026-10-12');
    await expect(page.locator('#booking-submit')).toBeDisabled();
    await expect(page.locator('#booking-error')).toContainText('successiva');
    await page.locator('#booking-end').fill('');
    await expect(page.locator('#booking-submit')).toBeDisabled();
    await expect(page.locator('#booking-error')).toContainText('Scegli le date');
    await page.locator('#booking-end').fill('2026-10-14');
    await expect(page.locator('#booking-submit')).toBeEnabled();
    await expect(page.locator('#booking-error')).toBeHidden();
    await page.locator('#booking-cancel').tap();
    expect(writes).toBe(0);
  });
});
