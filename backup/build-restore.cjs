// Produce a reviewable SQL restore file; never connects to a database.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {randomUUID} = require('node:crypto');

function buildRestore(snapshot) {
  const validator = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8'), validator);
  validator.validateBackup_(snapshot);
  const tag = '$restore_' + randomUUID().replaceAll('-', '') + '$';
  return `-- Private file: contains password hashes. Restore into an EMPTY prepared database.
begin;
lock table public.members, public.bookings in share row exclusive mode;
do $$ begin
  if exists (select 1 from public.members) or exists (select 1 from public.bookings) then
    raise exception 'Restore requires empty members and bookings tables';
  end if;
end $$;
insert into public.members (id, name, pin_hash, is_admin)
select id, name, pin_hash, is_admin
from jsonb_to_recordset(${tag}${JSON.stringify(snapshot.tables.members)}${tag}::jsonb)
  as rows(id uuid, name text, pin_hash text, is_admin boolean);
insert into public.bookings (id, member_id, start_date, end_date, note, created_at)
select id, member_id, start_date, end_date, note, created_at
from jsonb_to_recordset(${tag}${JSON.stringify(snapshot.tables.bookings)}${tag}::jsonb)
  as rows(id uuid, member_id uuid, start_date date, end_date date, note text, created_at timestamptz);
commit;
`;
}
module.exports = {buildRestore};
if (require.main === module) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error('Usage: node backup/build-restore.cjs snapshot.json output.sql');
    const sql = buildRestore(JSON.parse(fs.readFileSync(input, 'utf8')));
    // Refuse to overwrite an existing file, including the input snapshot.
    fs.writeFileSync(output, sql, {encoding:'utf8', flag:'wx', mode:0o600});
    console.log('Restore SQL created at ' + path.resolve(output));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
