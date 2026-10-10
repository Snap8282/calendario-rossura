/** Standalone Google Apps Script. Credentials belong in Script Properties only. */
function settings_() {
  const p = PropertiesService.getScriptProperties();
  const url = (p.getProperty('SUPABASE_URL') || '').replace(/\/$/, '');
  const key = p.getProperty('SUPABASE_SECRET_KEY') || '';
  const folder = p.getProperty('BACKUP_FOLDER_ID');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || !key.startsWith('sb_secret_') || !folder) {
    throw new Error('Set SUPABASE_URL, SUPABASE_SECRET_KEY (sb_secret_...), and BACKUP_FOLDER_ID in Script Properties.');
  }
  return {url, key, folder, properties: p, previousCounts: p.getProperty('LAST_BACKUP_COUNTS')};
}

function request_(config, path, method) {
  const response = UrlFetchApp.fetch(config.url + '/rest/v1/' + path, {
    method: method || 'get',
    headers: {apikey: config.key, 'Content-Type': 'application/json'},
    ...(method === 'post' ? {payload: '{}'} : {}),
    muteHttpExceptions: true,
    followRedirects: false
  });
  const code = response.getResponseCode();
  // Do not log credentials or raw response bodies (which may contain private data).
  if (code !== 200) throw new Error('Supabase request failed: HTTP ' + code);
  return JSON.parse(response.getContentText());
}

function runDailyBackup() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Another backup is running.');
  try {
    const config = settings_();
    const snapshot = request_(config, 'rpc/export_booking_backup', 'post');
    validateBackup_(snapshot);
    snapshot.source = config.url;
    const filename = 'rossura-backup-' + Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH-mm-ss") + '-' + Utilities.getUuid() + '.json';
    const folder = DriveApp.getFolderById(config.folder);
    const json = JSON.stringify(snapshot, null, 2);
    const file = folder.createFile(Utilities.newBlob(json, 'application/json', filename));
    // Verify the saved file before marking success or expiring older copies.
    if (file.getBlob().getDataAsString() !== json) throw new Error('Drive backup verification failed.');
    config.properties.setProperties({
      LAST_BACKUP_AT: new Date().toISOString(),
      LAST_BACKUP_FILE_ID: file.getId(),
      LAST_BACKUP_COUNTS: JSON.stringify({members: snapshot.tables.members.length, bookings: snapshot.tables.bookings.length})
    });
    config.properties.deleteProperty('LAST_BACKUP_ERROR');
    console.log('Backup saved: ' + file.getUrl() + '; members=' + snapshot.tables.members.length + '; bookings=' + snapshot.tables.bookings.length);
    // Preserve old copies when a valid snapshot has unexpectedly lost many rows.
    if (shouldPauseRetention_(config.previousCounts, snapshot)) {
      config.properties.setProperty('RETENTION_WARNING', 'Large row-count drop; old backups retained. Review before clearing this warning.');
    }
    if (!config.properties.getProperty('RETENTION_WARNING')) expireBackups_(folder, file.getId());
  } catch (error) {
    PropertiesService.getScriptProperties().setProperty('LAST_BACKUP_ERROR', new Date().toISOString() + ' ' + error.message);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function validateBackup_(snapshot) {
  if (!snapshot || snapshot.format_version !== 1 || !validTimestamp_(snapshot.snapshot_at) ||
      (snapshot.schema_version !== undefined && snapshot.schema_version !== 1) ||
      !snapshot.tables || !Array.isArray(snapshot.tables.members) || !Array.isArray(snapshot.tables.bookings)) {
    throw new Error('Unexpected backup format; no backup saved.');
  }
  const members = new Set();
  const names = new Set();
  snapshot.tables.members.forEach(row => {
    if (!row || !validUuid_(row.id) || members.has(row.id) || typeof row.name !== 'string' || !row.name || names.has(row.name) ||
        typeof row.is_admin !== 'boolean' || !Object.prototype.hasOwnProperty.call(row, 'pin_hash') ||
        (row.pin_hash !== null && typeof row.pin_hash !== 'string')) throw new Error('Invalid member data.');
    members.add(row.id);
    names.add(row.name);
  });
  const bookings = new Set();
  snapshot.tables.bookings.forEach(row => {
    if (!row || !validUuid_(row.id) || bookings.has(row.id) || !members.has(row.member_id) ||
        !validDate_(row.start_date) || !validDate_(row.end_date) || row.end_date <= row.start_date ||
        !validTimestamp_(row.created_at) || (row.note !== null && typeof row.note !== 'string')) throw new Error('Invalid booking data.');
    bookings.add(row.id);
  });
  const ordered = [...snapshot.tables.bookings].sort((a, b) => a.start_date.localeCompare(b.start_date));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].start_date < ordered[i - 1].end_date) throw new Error('Overlapping booking data.');
  }
}

function validUuid_(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value);
}
function validDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTimestamp_(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    validDate_(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}
function shouldPauseRetention_(previous, snapshot) {
  if (!previous) return false;
  try {
    const counts = JSON.parse(previous);
    return ['members', 'bookings'].some(table => counts[table] > 0 && snapshot.tables[table].length < counts[table] / 2);
  } catch (error) { return true; }
}

function expireBackups_(folder, currentId) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const files = folder.getFiles();
  const backups = [];
  while (files.hasNext()) {
    const file = files.next();
    if (/^rossura-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[a-f0-9-]+\.json$/.test(file.getName())) backups.push(file);
  }
  backups.sort((a, b) => b.getDateCreated().getTime() - a.getDateCreated().getTime());
  // Keep at least the two newest copies even after a long interruption.
  backups.slice(2).forEach(file => {
    if (file.getId() !== currentId && file.getDateCreated().getTime() < cutoff) file.setTrashed(true);
  });
}

/** Optional lightweight activity check; can succeed even with no bookings. */
function runHealthCheck() {
  const config = settings_();
  const rows = request_(config, 'bookings?select=id&limit=1');
  if (!Array.isArray(rows)) throw new Error('Unexpected health check response.');
  config.properties.setProperty('LAST_HEALTH_CHECK_AT', new Date().toISOString());
  checkBackupAge_(config.properties);
}

// The separate health trigger can detect a missing/stopped daily backup trigger.
// It still cannot detect failure of both triggers or loss of this Google account.
function checkBackupAge_(properties) {
  const last = properties.getProperty('LAST_BACKUP_AT');
  if (!last) return; // Health-check-only installations remain supported.
  if (!Number.isFinite(Date.parse(last)) || Date.now() - Date.parse(last) > 36 * 60 * 60 * 1000) {
    throw new Error('Last successful backup is older than 36 hours. Check the daily backup trigger.');
  }
}

/** Run after a successful manual backup. Repeat safely to replace your triggers. */
function installDailyTrigger() {
  settings_();
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'runDailyBackup') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('runDailyBackup').timeBased().atHour(3).everyDays(1).inTimezone('Europe/Zurich').create();
}

function installHealthCheckTrigger() {
  runHealthCheck();
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'runHealthCheck') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('runHealthCheck').timeBased().everyHours(6).create();
}
