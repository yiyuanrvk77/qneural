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
    if (!Array.isArray(data.conversations)) data.conversations = [];
    if (!Array.isArray(data.plans)) data.plans = [];
    return data;
  } catch (e) {
    return { users: [], networks: [], templates: [], conversations: [], plans: [] };
  }
}

let db = loadDB();

const DEFAULT_AI = {
  deepseekKey: '',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com',
  feishuWebhook: '',
  visionKey: '',
  visionModel: 'glm-4v-flash',
  visionBaseUrl: 'https://open.bigmodel.cn/api/paas/v4'
};

function normalizeAIConfig(c) {
  return {
    deepseekKey: typeof c.deepseekKey === 'string' ? c.deepseekKey : '',
    model: typeof c.model === 'string' && c.model ? c.model : DEFAULT_AI.model,
    baseUrl: typeof c.baseUrl === 'string' && c.baseUrl ? c.baseUrl.replace(/\/+$/, '') : DEFAULT_AI.baseUrl,
    feishuWebhook: typeof c.feishuWebhook === 'string' ? c.feishuWebhook : '',
    visionKey: typeof c.visionKey === 'string' ? c.visionKey : '',
    visionModel: typeof c.visionModel === 'string' && c.visionModel ? c.visionModel : DEFAULT_AI.visionModel,
    visionBaseUrl: typeof c.visionBaseUrl === 'string' && c.visionBaseUrl ? c.visionBaseUrl.replace(/\/+$/, '') : DEFAULT_AI.visionBaseUrl
  };
}

function getAIConfig(user) {
  const cfg = normalizeAIConfig(user && user.ai ? user.ai : {});
  if (process.env.DEEPSEEK_API_KEY) cfg.deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (process.env.VISION_API_KEY) cfg.visionKey = process.env.VISION_API_KEY;
  return cfg;
}

function deepseekKey(user) {
  return getAIConfig(user).deepseekKey;
}

function visionKey(user) {
  return getAIConfig(user).visionKey;
}

(function migrateLegacyAIConfig() {
  const legacyPath = path.join(DATA_DIR, 'config.json');
  let legacy = null;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
  } catch (e) {
    return;
  }
  if (!legacy || typeof legacy !== 'object') return;
  const hasValue = ['deepseekKey', 'feishuWebhook', 'visionKey'].some((k) => typeof legacy[k] === 'string' && legacy[k].trim());
  if (hasValue && db.users.length === 1 && !db.users[0].ai) {
    db.users[0].ai = normalizeAIConfig(legacy);
  }
})();

class HttpError extends Error {
  constructor(code, message) {
    super(message);
    this.httpCode = code;
  }
}

let dbWriting = false;
let dbDirty = false;

function saveDB() {
  if (db.templates.length === 0) db.templates = TEMPLATES.slice();
  if (dbWriting) {
    dbDirty = true;
    return;
  }
  dbWriting = true;
  const flush = async () => {
    do {
      dbDirty = false;
      const tmp = DB_PATH + '.tmp';
      await fs.promises.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
      await fs.promises.rename(tmp, DB_PATH);
    } while (dbDirty);
    dbWriting = false;
  };
  flush().catch((e) => {
    dbWriting = false;
    dbDirty = false;
    console.error('保存数据失败：', e);
  });
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
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt, memory: user.memory || '' };
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
  const nodeIds = new Set(cleanNodes.map((n) => n.id));
  const fusionSuggestions = normalizeFusionSuggestions(body.fusionSuggestions, nodeIds);
  return {
    title: String(body.title || '未命名网络').slice(0, 40),
    desc: String(body.desc || '').slice(0, 200),
    nodes: cleanNodes,
    links,
    fusionSuggestions
  };
}

function clamp01(v) {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function normalizeFusionSuggestions(list, nodeIds) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  list.slice(0, 200).forEach((s) => {
    if (!s || typeof s.id !== 'string' || seen.has(s.id)) return;
    const sourceId = String(s.sourceId || '').slice(0, 40);
    const targetId = String(s.targetId || '').slice(0, 40);
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId) || sourceId === targetId) return;
    const status = s.status === 'accepted' || s.status === 'dismissed' ? s.status : 'pending';
    out.push({
      id: String(s.id).slice(0, 40),
      sourceId,
      targetId,
      similarity: clamp01(Number(s.similarity)),
      innovation: clamp01(Number(s.innovation)),
      fusionProbability: clamp01(Number(s.fusionProbability)),
      reason: String(s.reason || '').slice(0, 200),
      status,
      createdAt: typeof s.createdAt === 'string' ? s.createdAt : nowISO(),
      updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : nowISO()
    });
    seen.add(s.id);
  });
  return out;
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
    fusionSuggestions: [],
    createdAt: nowISO(),
    updatedAt: nowISO()
  };
}

function buildSystem(user) {
  let sys = '你运行在「问络工作台」中，是一个类似 Codex 的自主工作助手：能对话、拆解目标、规划步骤并执行。回答用中文，代码用 Markdown 代码块，保持简洁。';
  sys += '\n当前时间：' + new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  if (user && user.memory) sys += '\n用户记忆（长期偏好，请尊重并善用）：\n' + user.memory;
  return sys;
}

async function callVision(user, imageUrl, prompt) {
  const cfg = getAIConfig(user);
  const key = cfg.visionKey;
  if (!key) throw new HttpError(400, '未配置识图 API Key，请先在「用户 → AI 设置」中配置');
  const body = {
    model: cfg.visionModel,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt || '请用中文详细描述这张图片的内容' },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    }]
  };
  const resp = await fetch(cfg.visionBaseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  if (!resp.ok) {
    let msg = resp.statusText;
    try {
      const e = await resp.json();
      if (e && e.error && e.error.message) msg = e.error.message;
    } catch (err) { /* ignore */ }
    throw new HttpError(502, '识图接口错误：' + msg);
  }
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('识图接口未返回内容');
  return content;
}

async function streamDeepSeek(user, messages, onToken) {
  const cfg = getAIConfig(user);
  const key = cfg.deepseekKey;
  if (!key) throw new HttpError(400, '未配置 DeepSeek API Key，请先在「用户 → AI 设置」中配置');
  const resp = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: cfg.model, temperature: 0.7, stream: true, messages }),
    signal: AbortSignal.timeout(180000)
  });
  if (!resp.ok) {
    let msg = resp.statusText;
    try {
      const e = await resp.json();
      if (e && e.error && e.error.message) msg = e.error.message;
    } catch (err) { /* ignore */ }
    throw new HttpError(502, 'DeepSeek 接口错误：' + msg);
  }
  if (!resp.body) throw new HttpError(502, 'DeepSeek 未返回流');
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buf += decoder.decode(r.value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (delta && typeof delta.content === 'string') onToken(delta.content);
      } catch (err) { /* ignore */ }
    }
  }
}

async function callDeepSeekJSON(user, messages) {
  const cfg = getAIConfig(user);
  const key = cfg.deepseekKey;
  if (!key) throw new HttpError(400, '未配置 DeepSeek API Key，请先在「用户 → AI 设置」中配置');
  const body = { model: cfg.model, temperature: 0.3, messages };
  if (cfg.model !== 'deepseek-reasoner') body.response_format = { type: 'json_object' };
  const resp = await fetch(cfg.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000)
  });
  if (!resp.ok) {
    let msg = resp.statusText;
    try {
      const e = await resp.json();
      if (e && e.error && e.error.message) msg = e.error.message;
    } catch (err) { /* ignore */ }
    throw new HttpError(502, 'DeepSeek 接口错误：' + msg);
  }
  const data = await resp.json();
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('AI 未返回内容');
  return content;
}

function extractJSON(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const o = JSON.parse(s);
    if (o && typeof o === 'object') return o;
  } catch (e) { /* continue */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      if (o && typeof o === 'object') return o;
    } catch (e) { /* continue */ }
  }
  return null;
}

async function sendFeishu(user, title, content) {
  const cfg = getAIConfig(user);
  const url = cfg.feishuWebhook;
  if (!url) return false;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: title + '\n' + content } }),
      signal: AbortSignal.timeout(10000)
    });
    return resp.ok;
  } catch (e) {
    console.error('飞书推送失败：', e.message);
    return false;
  }
}

function depthChain(n) {
  return (n.depth || []).slice(0, 3).map((d, i) => (i + 1) + '. ' + (d.q || '')).join(' ');
}

async function analyzeFusionPair(user, a, b) {
  const messages = [
    {
      role: 'system',
      content: '你是创新关联分析师。分析一对问题之间的关系。必须只输出一个 JSON 对象（不要输出其他内容）：{"similarity":0-1的浮点数表示语义相似度,"innovation":0-1的浮点数表示融合这两个问题产生新问题或新视角的潜力,"fusionProbability":0-1的浮点数表示值得推荐给用户融合的概率,"reason":"一句话中文解释，概率低时可为空字符串"}。评分规则：similarity 太低（<0.2）说明没有共同基础、太高（>0.9）说明几乎相同，这两种情况下 fusionProbability 都应较低；相似度中等（0.4-0.8）且 innovation 较高时，fusionProbability 最高。'
    },
    {
      role: 'user',
      content: '问题A："' + a.label + '"（追问链路：' + depthChain(a) + '）\n问题B："' + b.label + '"（追问链路：' + depthChain(b) + '）'
    }
  ];
  const content = await callDeepSeekJSON(user, messages);
  const obj = extractJSON(content);
  if (!obj) throw new Error('AI 返回格式无法解析，请重试');
  return {
    similarity: clamp01(Number(obj.similarity)),
    innovation: clamp01(Number(obj.innovation)),
    fusionProbability: clamp01(Number(obj.fusionProbability)),
    reason: String(obj.reason || '').slice(0, 200)
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
    db.networks.push({
      id: uid(),
      ownerId: user.id,
      title: '空白画布',
      desc: '',
      nodes: [],
      links: [],
      fusionSuggestions: [],
      createdAt: nowISO(),
      updatedAt: nowISO()
    });
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

  // ---- AI 设置 / 记忆 / 集成 ----
  if (p === '/api/config' && method === 'GET') {
    const cfg = getAIConfig(user);
    return sendJSON(res, 200, { hasKey: !!cfg.deepseekKey, model: cfg.model, baseUrl: cfg.baseUrl, hasFeishu: !!cfg.feishuWebhook, hasVisionKey: !!cfg.visionKey, visionModel: cfg.visionModel, visionBaseUrl: cfg.visionBaseUrl });
  }
  if (p === '/api/config' && method === 'PUT') {
    const body = await readBody(req);
    const cfg = getAIConfig(user);
    if (typeof body.deepseekKey === 'string' && body.deepseekKey.trim()) cfg.deepseekKey = body.deepseekKey.trim().slice(0, 200);
    if (typeof body.model === 'string' && body.model.trim()) cfg.model = body.model.trim().slice(0, 50);
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) {
      let u = body.baseUrl.trim().replace(/\/+$/, '');
      if (!/^https:\/\//.test(u)) return sendError(res, 400, '接口地址必须以 https:// 开头');
      cfg.baseUrl = u.slice(0, 200);
    }
    if (typeof body.feishuWebhook === 'string') cfg.feishuWebhook = body.feishuWebhook.trim().slice(0, 300);
    if (typeof body.visionKey === 'string' && body.visionKey.trim()) cfg.visionKey = body.visionKey.trim().slice(0, 200);
    if (typeof body.visionModel === 'string' && body.visionModel.trim()) cfg.visionModel = body.visionModel.trim().slice(0, 50);
    if (typeof body.visionBaseUrl === 'string' && body.visionBaseUrl.trim()) {
      const vu = body.visionBaseUrl.trim().replace(/\/+$/, '');
      if (!/^https:\/\//.test(vu)) return sendError(res, 400, '识图接口地址必须以 https:// 开头');
      cfg.visionBaseUrl = vu.slice(0, 200);
    }
    user.ai = cfg;
    saveDB();
    return sendJSON(res, 200, { ok: true, hasKey: !!cfg.deepseekKey, hasFeishu: !!cfg.feishuWebhook, hasVisionKey: !!cfg.visionKey });
  }
  if (p === '/api/me' && method === 'PUT') {
    const body = await readBody(req);
    if (typeof body.memory === 'string') {
      user.memory = body.memory.slice(0, 2000);
      saveDB();
    }
    return sendJSON(res, 200, { user: publicUser(user) });
  }
  if (p === '/api/integrations/test' && method === 'POST') {
    if (!getAIConfig(user).feishuWebhook) return sendError(res, 400, '请先在 AI 设置中填写飞书 Webhook 地址');
    const ok = await sendFeishu(user, '问络 · 测试通知', '飞书集成配置成功！以后融合建议和规划进度会自动推送到这里。');
    return sendJSON(res, 200, { ok });
  }

  // ---- 对话 ----
  if (p === '/api/conversations' && method === 'GET') {
    const list = db.conversations
      .filter((c) => c.ownerId === user.id)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((c) => ({
        id: c.id,
        title: c.title,
        messageCount: (c.messages || []).length,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      }));
    return sendJSON(res, 200, { conversations: list });
  }
  if (p === '/api/conversations' && method === 'POST') {
    const body = await readBody(req);
    const conv = {
      id: uid(),
      ownerId: user.id,
      title: String(body.title || '').trim().slice(0, 40) || '新对话',
      messages: [],
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    db.conversations.push(conv);
    saveDB();
    return sendJSON(res, 200, { conversation: conv });
  }
  const cm = p.match(/^\/api\/conversations\/([^/]+)$/);
  if (cm) {
    const conv = db.conversations.find((c) => c.id === cm[1]);
    if (!conv) return sendError(res, 404, '对话不存在');
    if (conv.ownerId !== user.id) return sendError(res, 403, '无权访问该对话');
    if (method === 'GET') return sendJSON(res, 200, { conversation: conv });
    if (method === 'DELETE') {
      db.conversations = db.conversations.filter((c) => c.id !== conv.id);
      saveDB();
      return sendJSON(res, 200, { ok: true });
    }
    if (method === 'PUT') {
      const body = await readBody(req);
      if (body.clear) {
        conv.messages = [];
        conv.updatedAt = nowISO();
        saveDB();
      }
      return sendJSON(res, 200, { conversation: conv });
    }
  }

  // ---- 流式聊天 ----
  if (p === '/api/vision' && method === 'POST') {
    const body = await readBody(req);
    const image = String(body.image || '').trim();
    if (!image) return sendError(res, 400, '请先上传或提供一张图片');
    const prompt = String(body.prompt || '').trim().slice(0, 2000);
    try {
      const description = await callVision(user, image, prompt);
      return sendJSON(res, 200, { description });
    } catch (e) {
      return sendError(res, e.httpCode || 500, e.message);
    }
  }

  if (p === '/api/chat' && method === 'POST') {
    const body = await readBody(req);
    const conv = db.conversations.find((c) => c.id === body.conversationId);
    if (!conv) return sendError(res, 404, '对话不存在');
    if (conv.ownerId !== user.id) return sendError(res, 403, '无权访问该对话');
    const msg = String(body.message || '').trim();
    if (!msg) return sendError(res, 400, '消息不能为空');
    if (!deepseekKey(user)) return sendError(res, 400, '未配置 DeepSeek API Key，请先在「AI 设置」中配置');
    if (!Array.isArray(conv.messages)) conv.messages = [];
    conv.messages.push({ role: 'user', content: msg, ts: nowISO() });
    if (conv.messages.length > 200) conv.messages = conv.messages.slice(-200);
    if (!conv.title || conv.title === '新对话') conv.title = msg.slice(0, 20) + (msg.length > 20 ? '…' : '');
    conv.updatedAt = nowISO();
    saveDB();
    const history = conv.messages.slice(-60).map((m) => ({ role: m.role, content: m.content }));
    const messages = [{ role: 'system', content: buildSystem(user) }].concat(history);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      'Connection': 'keep-alive'
    });
    res.flushHeaders();
    res.write('data: ' + JSON.stringify({ type: 'start' }) + '\n\n');
    let acc = '';
    try {
      await streamDeepSeek(user, messages, function (tok) {
        acc += tok;
        res.write('data: ' + JSON.stringify({ type: 'token', text: tok }) + '\n\n');
      });
    } catch (e) {
      res.write('data: ' + JSON.stringify({ type: 'error', message: e.httpCode ? e.message : ('AI 调用失败：' + e.message) }) + '\n\n');
      try { res.end(); } catch (err) { res.destroy(); }
      return;
    }
    conv.messages.push({ role: 'assistant', content: acc, ts: nowISO() });
    if (conv.messages.length > 200) conv.messages = conv.messages.slice(-200);
    conv.updatedAt = nowISO();
    saveDB();
    res.write('data: ' + JSON.stringify({ type: 'done', title: conv.title }) + '\n\n');
    try { res.end(); } catch (err) { res.destroy(); }
  }

  // ---- 对话提炼为问题网络 ----
  if (p === '/api/chat/extract' && method === 'POST') {
    const body = await readBody(req);
    const conv = db.conversations.find((c) => c.id === body.conversationId);
    if (!conv) return sendError(res, 404, '对话不存在');
    if (conv.ownerId !== user.id) return sendError(res, 403, '无权访问该对话');
    const msgs = conv.messages || [];
    if (msgs.length === 0) return sendError(res, 400, '对话还没有内容');
    const transcript = msgs.slice(-40).map((m) => m.role + '：' + String(m.content || '').slice(0, 800)).join('\n');
    try {
      const content = await callDeepSeekJSON(user, [
        { role: 'system', content: '你是一名问题提炼师。从对话中提炼出最值得追问的核心问题，输出 JSON：{"questions":[{"title":"一句话问题"}]}。最多 8 个，标题要具体、独立、可回答。只输出 JSON。' },
        { role: 'user', content: transcript }
      ]);
      const obj = extractJSON(content);
      const list = (obj && Array.isArray(obj.questions) ? obj.questions : [])
        .map((q) => String(q && q.title || '').trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 8);
      if (list.length === 0) return sendError(res, 502, 'AI 未能提炼出问题，请重试');
      return sendJSON(res, 200, { questions: list.map((title) => ({ title: title })) });
    } catch (e) {
      return sendError(res, e.httpCode || 500, e.message);
    }
  }

  // ---- 融合分析 ----
  if (p === '/api/fusion/analyze' && method === 'POST') {
    const body = await readBody(req);
    const net = db.networks.find((n) => n.id === body.networkId);
    if (!net) return sendError(res, 404, '网络不存在');
    if (net.ownerId !== user.id) return sendError(res, 403, '无权访问该网络');
    const a = net.nodes.find((n) => n.id === body.source);
    const b = net.nodes.find((n) => n.id === body.target);
    if (!a || !b || a.id === b.id) return sendError(res, 400, '请选择两个不同的节点');
    try {
      const r = await analyzeFusionPair(user, a, b);
      if (r.fusionProbability >= 0.55) {
        sendFeishu(user, '问络 · 新融合建议', '「' + a.label + '」 × 「' + b.label + '」\n融合概率 ' + Math.round(r.fusionProbability * 100) + '%\n' + (r.reason || ''));
      }
      return sendJSON(res, 200, {
        result: {
          source: a.id,
          target: b.id,
          similarity: r.similarity,
          innovation: r.innovation,
          fusionProbability: r.fusionProbability,
          reason: r.reason
        }
      });
    } catch (e) {
      return sendError(res, e.httpCode || 500, e.message);
    }
  }

  // ---- 自主规划 ----
  if (p === '/api/plans' && method === 'GET') {
    const list = db.plans
      .filter((pl) => pl.ownerId === user.id)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((pl) => ({
        id: pl.id,
        title: pl.title,
        goal: pl.goal,
        stepCount: (pl.steps || []).length,
        doneCount: (pl.steps || []).filter((s) => s.status === 'done').length,
        createdAt: pl.createdAt,
        updatedAt: pl.updatedAt
      }));
    return sendJSON(res, 200, { plans: list });
  }
  if (p === '/api/plans' && method === 'POST') {
    const body = await readBody(req);
    const goal = String(body.goal || '').trim().slice(0, 500);
    if (!goal) return sendError(res, 400, '请填写目标');
    const plan = {
      id: uid(),
      ownerId: user.id,
      title: String(body.title || '').trim().slice(0, 40) || goal.slice(0, 20),
      goal: goal,
      steps: [],
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
    db.plans.push(plan);
    saveDB();
    try {
      const content = await callDeepSeekJSON(user, [
        { role: 'system', content: '你是一个任务规划师。把用户目标拆解为 3-6 个可执行、可验证的步骤。输出 JSON：{"steps":[{"title":"步骤名","detail":"做什么、怎么做、完成标准"}]}。步骤要按顺序、相互独立。只输出 JSON。' },
        { role: 'user', content: goal }
      ]);
      const obj = extractJSON(content);
      const steps = (obj && Array.isArray(obj.steps) ? obj.steps : [])
        .slice(0, 6)
        .map((s) => ({
          title: String(s && s.title || '').trim().slice(0, 40),
          detail: String(s && s.detail || '').trim().slice(0, 300)
        }))
        .filter((s) => s.title);
      plan.steps = steps.map((s) => ({ id: uid(), title: s.title, detail: s.detail, status: 'pending', result: '', error: '', updatedAt: nowISO() }));
    } catch (e) {
      plan.steps = [{ id: uid(), title: '拆解并推进目标', detail: goal, status: 'pending', result: '', error: '', updatedAt: nowISO() }];
    }
    plan.updatedAt = nowISO();
    saveDB();
    return sendJSON(res, 200, { plan: plan });
  }
  const pm = p.match(/^\/api\/plans\/([^/]+)$/);
  if (pm && (method === 'GET' || method === 'DELETE')) {
    const plan = db.plans.find((pl) => pl.id === pm[1]);
    if (!plan) return sendError(res, 404, '规划不存在');
    if (plan.ownerId !== user.id) return sendError(res, 403, '无权访问该规划');
    if (method === 'GET') return sendJSON(res, 200, { plan: plan });
    db.plans = db.plans.filter((pl) => pl.id !== plan.id);
    saveDB();
    return sendJSON(res, 200, { ok: true });
  }
  const sm = p.match(/^\/api\/plans\/([^/]+)\/steps\/([^/]+)(\/run)?$/);
  if (sm && (method === 'POST' || method === 'PUT')) {
    const plan = db.plans.find((pl) => pl.id === sm[1]);
    if (!plan) return sendError(res, 404, '规划不存在');
    if (plan.ownerId !== user.id) return sendError(res, 403, '无权访问该规划');
    const step = (plan.steps || []).find((s) => s.id === sm[2]);
    if (!step) return sendError(res, 404, '步骤不存在');
    const isRun = sm[3] === '/run';
    if (method === 'PUT' && !isRun) {
      const body = await readBody(req);
      if (body.status === 'done' || body.status === 'pending' || body.status === 'failed') step.status = body.status;
      if (typeof body.result === 'string') step.result = body.result.slice(0, 8000);
      step.error = '';
      step.updatedAt = nowISO();
      plan.updatedAt = nowISO();
      saveDB();
      return sendJSON(res, 200, { plan: plan });
    }
    if (method === 'POST' && isRun) {
      if (step.status === 'running') return sendError(res, 400, '该步骤正在执行中');
      step.status = 'running';
      step.updatedAt = nowISO();
      plan.updatedAt = nowISO();
      saveDB();
      try {
        const prev = plan.steps
          .filter((s) => s.status === 'done' && s.id !== step.id)
          .map((s) => '已完成：' + s.title + (s.result ? '——' + String(s.result).slice(0, 400) : ''))
          .join('\n');
        const content = await callDeepSeekJSON(user, [
          { role: 'system', content: '你是「问络工作台」的执行助手。针对给定的任务步骤，输出具体、可落地的执行结果（方案、清单、代码或要点均可）。回答用中文。' },
          { role: 'user', content: '目标：' + plan.goal + '\n当前步骤：' + step.title + '\n步骤说明：' + step.detail + (prev ? '\n已完成步骤的产出：\n' + prev : '') }
        ]);
        step.result = content.slice(0, 8000);
        step.status = 'done';
      } catch (e) {
        step.status = 'failed';
        step.error = e.httpCode ? e.message : ('执行失败：' + e.message);
      }
      step.updatedAt = nowISO();
      plan.updatedAt = nowISO();
      saveDB();
      if (step.status === 'done') sendFeishu(user, '问络 · 规划进度', '步骤完成：「' + step.title + '」\n目标：' + plan.goal.slice(0, 100));
      return sendJSON(res, 200, { plan: plan });
    }
    return sendError(res, 405, '方法不允许');
  }

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
      fusionSuggestions: clean.fusionSuggestions,
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
    net.fusionSuggestions = clean.fusionSuggestions;
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
      sendError(res, e && e.httpCode ? e.httpCode : 400, e.message || '请求失败');
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

function saveDBSync() {
  if (db.templates.length === 0) db.templates = TEMPLATES.slice();
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

let shuttingDown = false;
let finalized = false;

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n收到 ' + signal + '，正在保存数据后退出…');

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    try {
      if (!dbWriting && dbDirty) saveDBSync();
    } catch (e) {
      console.error('保存数据失败：', e);
    }
    process.exit(0);
  };

  const timer = setTimeout(finalize, 3000);

  if (server.listening) {
    server.close(() => {
      if (dbWriting) {
        const iv = setInterval(() => {
          if (!dbWriting) {
            clearInterval(iv);
            clearTimeout(timer);
            finalize();
          }
        }, 20);
      } else {
        clearTimeout(timer);
        finalize();
      }
    });
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
  } else {
    finalize();
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

saveDB();
listen(PORT, 0);
