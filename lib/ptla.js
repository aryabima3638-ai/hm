// Create Panel: bikin user + server Pterodactyl lewat Application API (khusus owner)
// Config di setting.js -> ptla: { domain, key, locationId, eggId, dockerImage, startup, ... }
const crypto = require('crypto');
const S = require('../setting');

function cfg() {
  const p = S.ptla || {};
  return {
    ...p,
    domain: String(p.domain || '').trim().replace(/\/+$/, ''),
    key: String(p.key || '').trim(),
  };
}

async function api(method, route, body) {
  const c = cfg();
  if (!c.domain || !c.key) throw new Error('PTLA belum diisi di setting.js (ptla.domain & ptla.key).');
  const res = await fetch(c.domain + '/api/application' + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + c.key,
      Accept: 'Application/vnd.pterodactyl.v1+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const txt = await res.text();
  let j = {};
  try { j = JSON.parse(txt); } catch {}
  if (!res.ok) {
    const detail = Array.isArray(j.errors) ? j.errors.map((e) => e.detail).join('; ') : '';
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return j;
}

const randPass = () => crypto.randomBytes(9).toString('base64url');
const VALID_USER = /^[a-z0-9_-]{3,30}$/i;

// preset: 'std' (pakai limit dari ptla) atau 'unli' (pakai ptla.unli, tanpa batas RAM/disk/CPU)
async function createPanel({ username, preset = 'std' }) {
  if (!VALID_USER.test(username)) throw new Error('Username harus 3-30 karakter (huruf, angka, _ atau -).');
  const c = cfg();
  if (!c.locationId || !c.eggId) throw new Error('ptla.locationId dan ptla.eggId belum diisi di setting.js.');
  const pass = randPass();
  const email = `${username.toLowerCase()}@${c.autoEmailDomain || 'ptla.local'}`;
  const lim = preset === 'unli' ? { ...c, ...(c.unli || {}) } : c;

  const u = await api('POST', '/users', {
    email,
    username,
    first_name: username,
    last_name: 'User',
    password: pass,
  });
  const userId = u.attributes.id;

  const s = await api('POST', '/servers', {
    name: `${username}-server`,
    user: userId,
    egg: Number(c.eggId),
    docker_image: c.dockerImage,
    startup: c.startup,
    environment: c.env || {},
    limits: {
      memory: lim.memory ?? 1024,
      swap: lim.swap ?? 0,
      disk: lim.disk ?? 5120,
      io: lim.io ?? 500,
      cpu: lim.cpu ?? 100,
    },
    feature_limits: {
      databases: lim.databases ?? 0,
      allocations: lim.allocations ?? 1,
      backups: lim.backups ?? 0,
    },
    deploy: { locations: [Number(c.locationId)], dedicated_ip: false, port_range: [] },
    start_on_completion: true,
  });

  return {
    url: c.domain,
    username,
    email,
    password: pass,
    userId,
    serverId: s.attributes.identifier,
    preset,
  };
}

module.exports = { createPanel, cfg };
