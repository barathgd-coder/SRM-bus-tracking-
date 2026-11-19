'use strict';
// SRM Trichy Bus Tracking - backend (Node.js 22.13+, no npm packages needed)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'ADMIN1234';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin1234';
const DIR = __dirname, PUB = path.join(DIR, 'public');
fs.mkdirSync(path.join(DIR, 'data'), { recursive: true });
const db = new DatabaseSync(process.env.DB_FILE || path.join(DIR, 'data', 'srm-bus.db'));

db.exec(`
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS drivers(bus TEXT PRIMARY KEY,name TEXT NOT NULL,age INTEGER,phone TEXT,pw TEXT NOT NULL,route TEXT,last_login TEXT,login_count INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS students(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL COLLATE NOCASE,code TEXT NOT NULL,bus TEXT,route TEXT,first_login TEXT,last_login TEXT,login_count INTEGER DEFAULT 0,UNIQUE(name,code));
CREATE TABLE IF NOT EXISTS logins(id INTEGER PRIMARY KEY AUTOINCREMENT,role TEXT,name TEXT,uid TEXT,bus TEXT,route TEXT,time TEXT);
CREATE TABLE IF NOT EXISTS passes(code TEXT PRIMARY KEY,active INTEGER DEFAULT 1,name TEXT,num TEXT,bus TEXT);
CREATE TABLE IF NOT EXISTS bus_state(bus TEXT PRIMARY KEY,crowd TEXT,status TEXT,fz REAL,gps TEXT,delay INTEGER,o REAL);
CREATE TABLE IF NOT EXISTS alerts(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT,bus TEXT,txt TEXT,time TEXT,res INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,num TEXT,bus TEXT,route TEXT,text TEXT,reply TEXT,time TEXT);
`);

// first start: load 60 drivers + 100 bus pass codes from seed.json
if (!db.prepare('SELECT COUNT(*) c FROM drivers').get().c) {
  const seed = JSON.parse(fs.readFileSync(path.join(DIR, 'seed.json'), 'utf8'));
  const insD = db.prepare('INSERT INTO drivers(bus,name,age,phone,pw,route) VALUES(?,?,?,?,?,?)');
  const insB = db.prepare("INSERT INTO bus_state(bus,crowd,status,delay) VALUES(?,'LOW','ON TIME',0)");
  const insP = db.prepare('INSERT INTO passes(code,active,name,num,bus) VALUES(?,1,?,?,?)');
  db.exec('BEGIN');
  for (const d of seed.drivers) { insD.run(d.bus, d.name, d.age, d.phone, d.pw, d.route); insB.run(d.bus); }
  for (const p of seed.passes) insP.run(p.code, p.name, p.num, p.bus);
  db.exec('COMMIT');
  console.log('Database created and seeded.');
}

const tokens = new Set();
const nowS = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
const str = x => (x == null ? '' : String(x).slice(0, 500));
const num = x => (typeof x === 'number' && isFinite(x) ? x : null);
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise(ok => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ok({}); } });
});
const isAdmin = req => tokens.has(req.headers['x-token']);
const logLogin = (role, name, uid, bus, route, time) =>
  db.prepare('INSERT INTO logins(role,name,uid,bus,route,time) VALUES(?,?,?,?,?,?)').run(role, name, uid, bus, route, time);

function state(req, q) {
  const adm = isAdmin(req), bus = q.get('bus'), n = q.get('num');
  const bs = {}, dr = {};
  for (const r of db.prepare('SELECT * FROM bus_state').all())
    bs[r.bus] = { crowd: r.crowd, status: r.status, fz: r.fz, gps: r.gps ? JSON.parse(r.gps) : null, delay: r.delay, o: r.o };
  for (const r of db.prepare('SELECT * FROM drivers').all())
    dr[r.bus] = { name: r.name, age: r.age, phone: r.phone, last: r.last_login, count: r.login_count };
  let ms = [];
  if (adm) ms = db.prepare('SELECT * FROM messages ORDER BY id').all();
  else if (bus) ms = n
    ? db.prepare('SELECT * FROM messages WHERE bus=? AND num=? ORDER BY id').all(bus, n)
    : db.prepare('SELECT * FROM messages WHERE bus=? ORDER BY id').all(bus);
  const out = { bs, dr, ms, al: [], ps: {}, lg: [], st: {} };
  if (adm) {
    out.al = db.prepare('SELECT * FROM alerts ORDER BY id').all().map(a => ({ ...a, res: !!a.res }));
    for (const p of db.prepare('SELECT * FROM passes').all()) out.ps[p.code] = { active: !!p.active, name: p.name, num: p.num, bus: p.bus };
    out.lg = db.prepare('SELECT * FROM (SELECT * FROM logins ORDER BY id DESC LIMIT 1000) ORDER BY id').all()
      .map(l => ({ role: l.role, name: l.name, id: l.uid, bus: l.bus, route: l.route, time: l.time }));
    for (const s of db.prepare('SELECT * FROM students ORDER BY id').all())
      out.st[s.id] = { name: s.name, code: s.code, bus: s.bus, route: s.route, first: s.first_login, last: s.last_login, count: s.login_count };
  }
  return out;
}

async function api(req, res, u) {
  const p = u.pathname.replace(/^\/api\//, '').split('/'), m = req.method;
  const b = m === 'GET' ? {} : await readBody(req);
  const needAdmin = () => { if (!isAdmin(req)) { send(res, 401, { error: 'Admin login required' }); return false; } return true; };

  if (m === 'GET' && p[0] === 'state') return send(res, 200, state(req, u.searchParams));

  if (m === 'POST' && p[0] === 'login') {
    const t = nowS();
    if (p[1] === 'driver') {
      const bus = str(b.u).toUpperCase(), d = db.prepare('SELECT * FROM drivers WHERE bus=?').get(bus);
      if (!d || d.pw !== str(b.p).toUpperCase()) return send(res, 401, { ok: false, error: 'Invalid driver credentials' });
      db.prepare('UPDATE drivers SET last_login=?,login_count=login_count+1 WHERE bus=?').run(t, bus);
      logLogin('DRIVER', d.name, bus, bus, d.route, t);
      return send(res, 200, { ok: true, name: d.name });
    }
    if (p[1] === 'student') {
      const name = str(b.name).trim(), code = str(b.code).trim().toUpperCase(), bus = str(b.bus).toUpperCase(), route = str(b.route);
      if (!name) return send(res, 400, { ok: false, error: 'Please enter your name.' });
      if (!code) return send(res, 400, { ok: false, error: 'Please enter your bus pass code.' });
      const pass = db.prepare('SELECT * FROM passes WHERE code=?').get(code);
      if (!pass) return send(res, 401, { ok: false, error: '❌ INVALID BUS PASS CODE\n\nAccess denied.\nPlease enter your registered bus pass code.' });
      if (!pass.active) return send(res, 403, { ok: false, error: '❌ BUS PASS INACTIVE\n\nThis pass has been disabled. Contact admin.' });
      if (!route) return send(res, 400, { ok: false, error: 'Please select your route.' });
      const d = db.prepare('SELECT * FROM drivers WHERE bus=?').get(bus);
      if (!bus || !d) return send(res, 400, { ok: false, error: 'Please select your bus.' });
      if (d.route !== route) return send(res, 400, { ok: false, error: `${bus} is not on route ${route}.` });
      db.prepare(`INSERT INTO students(name,code,bus,route,first_login,last_login,login_count) VALUES(?,?,?,?,?,?,1)
        ON CONFLICT(name,code) DO UPDATE SET bus=excluded.bus,route=excluded.route,last_login=excluded.last_login,login_count=login_count+1`)
        .run(name, code, bus, route, t, t);
      logLogin('STUDENT', name, code, bus, route, t);
      return send(res, 200, { ok: true });
    }
    if (p[1] === 'admin') {
      if (b.u !== ADMIN_USER || b.p !== ADMIN_PASS) return send(res, 401, { ok: false, error: 'Invalid admin credentials' });
      const token = crypto.randomUUID(); tokens.add(token);
      return send(res, 200, { ok: true, token });
    }
  }

  if (m === 'PUT' && p[0] === 'bus' && p[1]) {
    const crowd = ['LOW', 'MEDIUM', 'HIGH'].includes(b.crowd) ? b.crowd : 'LOW';
    const status = ['ON TIME', 'DELAYED', 'BREAKDOWN', 'EMERGENCY', 'OFFLINE'].includes(b.status) ? b.status : 'ON TIME';
    const gps = Array.isArray(b.gps) && b.gps.length === 2 && b.gps.every(num) ? JSON.stringify(b.gps) : null;
    const r = db.prepare('UPDATE bus_state SET crowd=?,status=?,fz=?,gps=?,delay=?,o=? WHERE bus=?')
      .run(crowd, status, num(b.fz), gps, Math.round(num(b.delay) || 0), num(b.o), p[1].toUpperCase());
    return send(res, r.changes ? 200 : 404, { ok: !!r.changes });
  }

  if (m === 'POST' && p[0] === 'alerts') {
    const r = db.prepare('INSERT INTO alerts(type,bus,txt,time) VALUES(?,?,?,?)').run(str(b.type), str(b.bus), str(b.txt), nowS());
    return send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
  }
  if (m === 'PATCH' && p[0] === 'alerts') {
    if (!needAdmin()) return;
    db.prepare('UPDATE alerts SET res=? WHERE id=?').run(b.res ? 1 : 0, +p[1]);
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p[0] === 'messages') {
    const r = db.prepare('INSERT INTO messages(name,num,bus,route,text,time) VALUES(?,?,?,?,?,?)')
      .run(str(b.name), str(b.num), str(b.bus), str(b.route), str(b.text), nowS());
    return send(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
  }
  if (m === 'PATCH' && p[0] === 'messages') {
    db.prepare('UPDATE messages SET reply=? WHERE id=?').run(str(b.reply), +p[1]);
    return send(res, 200, { ok: true });
  }

  if (m === 'PUT' && p[0] === 'drivers' && p[1]) {
    if (!needAdmin()) return;
    const r = db.prepare("UPDATE drivers SET name=?,age=?,phone=?,pw=COALESCE(NULLIF(?,''),pw) WHERE bus=?")
      .run(str(b.name), Math.round(num(b.age) || 0), str(b.phone), str(b.pw).toUpperCase(), p[1].toUpperCase());
    return send(res, 200, { ok: !!r.changes });
  }
  if (m === 'PUT' && p[0] === 'passes' && p[1]) {
    if (!needAdmin()) return;
    const bus = b.bus ? str(b.bus).toUpperCase() : null;
    if (bus && !db.prepare('SELECT 1 FROM drivers WHERE bus=?').get(bus)) return send(res, 400, { ok: false, error: 'Unknown bus' });
    db.prepare('UPDATE passes SET active=COALESCE(?,active),bus=COALESCE(?,bus) WHERE code=?')
      .run(b.active == null ? null : (b.active ? 1 : 0), bus, p[1].toUpperCase());
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p[0] === 'passes') {
    if (!needAdmin()) return;
    const bus = str(b.bus).toUpperCase();
    if (!str(b.name) || !str(b.num) || !db.prepare('SELECT 1 FROM drivers WHERE bus=?').get(bus)) return send(res, 400, { ok: false, error: 'Invalid input' });
    let code; do { code = crypto.randomBytes(6).toString('hex').slice(0, 8).toUpperCase(); } while (db.prepare('SELECT 1 FROM passes WHERE code=?').get(code));
    db.prepare('INSERT INTO passes(code,active,name,num,bus) VALUES(?,1,?,?,?)').run(code, str(b.name), str(b.num), bus);
    return send(res, 200, { ok: true, code });
  }
  send(res, 404, { error: 'Not found' });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    const f = path.join(PUB, path.normalize(u.pathname === '/' ? '/index.html' : u.pathname));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: 'Server error' }); }
}).listen(PORT, '0.0.0.0', () => console.log(`SRM Bus Tracking running → http://localhost:${PORT}`));
