'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const SECRET_PATH = path.join(DATA_DIR, 'secret');
const TEMPLATES = require('./lib/templates').TEMPLATES;

const DEFAULT_PORT = 3000;
const PORT = parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const MAX_BODY = 8 * 1024 * 1024;
const COOKIE_NAME = 'qn_token';
const TOKEN_TTL = 7 * 24 * 3600 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

let SECRET;
try {
  SECRET = fs.readFileSync(SECRET_PATH, 'utf8').trim();
} catch (e) {
  SECRET = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_PATH, SECRET, { mode: 0o600 });
}

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.users)) data.users = [];
    if (!Array.isArray(data.networks)) data.networks = [];
    if (!Array.isArray(data.templates)) data.templates = [];
    return data;
  } catch (e) {
    return { users: [], networks: [], templates: [] };
  }
}

let db = loadDB();

function saveDB() {
  if (db.templates.length === 0) db.templates = TEMPLATES.slice();
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function uid() {
  return crypto.randomBytes(8).toString('hex') + Date.now().toString(36);
}

function nowISO() {
  return new Date().toISOString();
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signToken(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[1]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (!payload.uid || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  const payload = verifyToken(token);
  if (!payload) return null;
  const user = db.users.find((u) => u.id === payload.uid);
  return user || null;
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function sendError(res, code, error) {
  sendJSON(res, code, { error: String(error) });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('JSON 格式错误'));
      }
    });
    req.on('error', reject);
  });
}

const VALID_TYPES = new Set(['goal', 'ask', 'think', 'act']);

function normalizeDepth(depth) {
  if (!Array.isArray(depth) || depth.length === 0) {
    return [{ q: '这个问题具体指什么？', a: '先缩小边界，再给出一个例子。', opts: ['定义', '边界', '例子'], extra: '' }];
  }
  return depth.slice(0, 8).map((d) => ({
    q: String(d.q || '').slice(0, 120),
    a: String(d.a || '').slice(0, 300),
    opts: Array.isArray(d.opts) ? d.opts.map((o) => String(o).slice(0, 30)).filter(Boolean).slice(0, 6) : [],
    extra: String(d.extra || '').slice(0, 300)
  })).filter((d) => d.q);
}

function normalizeNetwork(body) {
  const nodes = Array.isArray(body.nodes) ? body.nodes.slice(0, 500) : [];
  const seen = new Set();
  const cleanNodes = [];
  nodes.forEach((n) => {
    if (!n || typeof n.id !== 'string' || seen.has(n.id)) return;
    const type = VALID_TYPES.has(n.type) ? n.type : 'think';
    cleanNodes.push({
      id: n.id,
      label: String(n.label || '未命名问题').slice(0, 40),
      type,
      x: Number.isFinite(n.x) ? Math.round(n.x) : 0,
      y: Number.isFinite(n.y) ? Math.round(n.y) : 0,
      depth: normalizeDepth(n.depth)
    });
    seen.add(n.id);
  });
  const ids = new Set(cleanNodes.map((n) => n.id));
  const seenLinks = new Set();
  const links = [];
  (Array.isArray(body.links) ? body.links : []).forEach((l) => {
    if (!l || !ids.has(l.s) || !ids.has(l.t) || l.s === l.t) return;
    const key = l.s + '>' + l.t;
    const rev = l.t + '>' + l.s;
    if (seenLinks.has(key) || seenLinks.has(rev)) return;
    seenLinks.add(key);
    links.push({ s: l.s, t: l.t });
  });
  return {
    title: String(body.title || '未命名网络').slice(0, 40),
    desc: String(body.desc || '').slice(0, 200),
    nodes: cleanNodes,
    links
  };
}

function cloneTemplate(tpl, ownerId, title) {
  const nodes = tpl.nodes.map((n) => ({
    id: uid(),
    label: n.label,
    type: n.type,
    x: n.x + (Math.random() * 40 - 20),
    y: n.y + (Math.random() * 30 - 15),
    depth: n.depth.map((d) => ({ q: d.q, a: d.a, opts: d.opts.slice(), extra: d.extra }))
  }));
  const map = {};
  tpl.nodes.forEach((n, i) => { map[n.id] = nodes[i].id; });
  const links = tpl.links.map((l) => ({ s: map[l.s], t: map[l.t] }));
  return {
    id: uid(),
    ownerId,
    title: title || tpl.title,
    desc: tpl.desc || '',
    nodes,
    links,
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

const RATE = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hit = RATE.get(ip) || { n: 0, reset: now + 60000 };
  if (now > hit.reset) {
    hit.n = 0;
    hit.reset = now + 60000;
  }
  hit.n += 1;
  RATE.set(ip, hit);
  return hit.n > 60;
}

function setCookie(res, token) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
}

function clearCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const filePath = path.normalize(path.join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== path.join(PUBLIC, 'index.html')) {
    return sendError(res, 403, '禁止访问');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return sendError(res, 404, '页面不存在');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

async function handleAPI(req, res, url) {
  const method = req.method;
  const p = url.pathname;
  const ip = req.socket.remoteAddress || 'local';

  if (p === '/api/health' && method === 'GET') {
    return sendJSON(res, 200, { ok: true, name: 'qneural', version: '1.0.0' });
  }

  if (p === '/api/auth/register' && method === 'POST') {
    if (rateLimited(ip)) return sendError(res, 429, '操作过于频繁，请稍后再试');
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 20);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 120);
    const password = String(body.password || '');
    if (!name) return sendError(res, 400, '请输入昵称');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendError(res, 400, '邮箱格式不正确');
    if (password.length < 6) return sendError(res, 400, '密码至少 6 位');
    if (db.users.some((u) => u.email === email)) return sendError(res, 409, '该邮箱已注册，请直接登录');
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: uid(),
      name,
      email,
      salt,
      passHash: hashPassword(password, salt),
      createdAt: nowISO()
    };
    db.users.push(user);
    const tpl = db.templates[0] || TEMPLATES[0];
    db.networks.push(cloneTemplate(tpl, user.id, '我的第一个问题网络'));
    saveDB();
    setCookie(res, signToken({ uid: user.id, exp: Date.now() + TOKEN_TTL }));
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (p === '/api/auth/login' && method === 'POST') {
    if (rateLimited(ip)) return sendError(res, 429, '操作过于频繁，请稍后再试');
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const user = db.users.find((u) => u.email === email);
    if (!user || !verifyPassword(String(body.password || ''), user.salt, user.passHash)) {
      return sendError(res, 401, '邮箱或密码不正确');
    }
    setCookie(res, signToken({ uid: user.id, exp: Date.now() + TOKEN_TTL }));
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (p === '/api/auth/logout' && method === 'POST') {
    clearCookie(res);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/me' && method === 'GET') {
    const user = currentUser(req);
    if (!user) return sendError(res, 401, '未登录');
    return sendJSON(res, 200, { user: publicUser(user) });
  }

  if (p === '/api/templates' && method === 'GET') {
    const list = db.templates.map((t) => ({
      id: t.id,
      title: t.title,
      desc: t.desc,
      nodeCount: t.nodes.length
    }));
    return sendJSON(res, 200, { templates: list });
  }

  const user = currentUser(req);
  if (!user) return sendError(res, 401, '请先登录');

  if (p === '/api/networks' && method === 'GET') {
    const list = db.networks
      .filter((n) => n.ownerId === user.id)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((n) => ({
        id: n.id,
        title: n.title,
        desc: n.desc,
        nodeCount: n.nodes.length,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt
      }));
    return sendJSON(res, 200, { networks: list });
  }

  if (p === '/api/networks' && method === 'POST') {
    const body = await readBody(req);
    if (body.fromTemplate) {
      const tpl = db.templates.find((t) => t.id === body.fromTemplate);
      if (!tpl) return sendError(res, 404, '模板不存在');
      const net = cloneTemplate(tpl, user.id, body.title);
      db.networks.push(net);
      saveDB();
      return sendJSON(res, 200, { network: net });
    }
    const clean = normalizeNetwork(body);
    if (clean.nodes.length === 0) clean.nodes = [];
    const net = {
      id: uid(),
      ownerId: user.id,
      title: clean.title,
      desc: clean.desc,
      nodes: clean.nodes,
      links: clean.links,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    db.networks.push(net);
    saveDB();
    return sendJSON(res, 200, { network: net });
  }

  const m = p.match(/^\/api\/networks\/([^/]+)$/);
  if (m && (method === 'GET' || method === 'PUT' || method === 'DELETE')) {
    const net = db.networks.find((n) => n.id === m[1]);
    if (!net) return sendError(res, 404, '网络不存在');
    if (net.ownerId !== user.id) return sendError(res, 403, '无权访问该网络');
    if (method === 'GET') return sendJSON(res, 200, { network: net });
    if (method === 'DELETE') {
      db.networks = db.networks.filter((n) => n.id !== net.id);
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }
    const body = await readBody(req);
    const clean = normalizeNetwork(body);
    net.title = clean.title;
    net.desc = clean.desc;
    net.nodes = clean.nodes;
    net.links = clean.links;
    net.updatedAt = nowISO();
    saveDB();
    return sendJSON(res, 200, { network: net });
  }

  return sendError(res, 404, '接口不存在');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleAPI(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    try {
      sendError(res, 400, e.message || '请求失败');
    } catch (err) {
      res.destroy();
    }
  }
});

function listen(port, attempt) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 10 && !process.env.PORT) {
      listen(port + 1, attempt + 1);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  server.listen(port, () => {
    console.log('问络 · 问题神经网络平台已启动');
    console.log('访问地址：http://localhost:' + port);
    console.log('数据目录：' + DATA_DIR);
  });
}

saveDB();
listen(PORT, 0);
