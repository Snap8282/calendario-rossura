// Optional production audit: HEAD requests only; does not retrieve row values or write data.
const fs = require('node:fs');
const vm = require('node:vm');
const config = vm.createContext({});
vm.runInContext(fs.readFileSync('config.js','utf8') + '\nglobalThis.url=SUPABASE_URL; globalThis.key=SUPABASE_ANON_KEY;', config);
(async () => {
  let failed=false;
  for (const [path, mustBeReadable] of [['members_public?select=id&limit=1',true],['bookings?select=id&limit=1',true],['members?select=pin_hash&limit=1',false]]) {
    const response=await fetch(config.url+'/rest/v1/'+path,{method:'HEAD',headers:{apikey:config.key,Authorization:'Bearer '+config.key},signal:AbortSignal.timeout(15000),redirect:'error'});
    const good=mustBeReadable ? response.status===200 : [401,403].includes(response.status);
    console.log(`${good ? 'PASS' : 'FAIL'} ${path}: HTTP ${response.status}`);
    if (!good) failed=true;
  }
  if (failed) process.exitCode=1;
})().catch(error => {console.error(error.message); process.exitCode=1;});
