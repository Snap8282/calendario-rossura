// Serve only the UI assets. Never expose backups or the real config to the browser.
const http = require('node:http');
const fs = require('node:fs');
const allowed = new Set(['index.html','app.js','style.css',
  'vendor/supabase-2.112.4.min.js','vendor/fullcalendar-6.1.15.min.js',
  'vendor/fullcalendar-locale-it-6.1.15.min.js','assets/rossura.webp']);
http.createServer((req,res) => {
  const path = new URL(req.url,'http://127.0.0.1').pathname.slice(1) || 'index.html';
  if (path === 'config.js') {
    res.setHeader('Content-Type','text/javascript');
    return res.end('const SUPABASE_URL="https://test.supabase.co"; const SUPABASE_ANON_KEY="test-key";');
  }
  if (!allowed.has(path) || !fs.existsSync(path)) {res.writeHead(404); return res.end();}
  res.setHeader('Content-Type',path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.webp') ? 'image/webp' : 'text/html');
  fs.createReadStream(path).pipe(res);
}).listen(4173,'127.0.0.1');
