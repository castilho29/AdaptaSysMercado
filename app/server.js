'use strict';
/* =====================================================================
   ADAPTASYS MERCADO · servidor local do PDV (um por empresa)
   - Banco local SQLite (pasta "dados"): o caixa vende sem internet.
   - Sincroniza com o Supabase quando há internet:
       envia vendas/movimentos da fila e puxa produtos, pedidos e ajustes.
   - Imprime direto na impressora térmica (ESC/POS) pelo Windows.
   Requer Node.js 22.13 ou mais novo (tem SQLite embutido).
   ===================================================================== */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname, PUB = path.join(ROOT, 'public'), DATA = process.env.PDV_DATA || path.join(ROOT, 'dados');
fs.mkdirSync(path.join(DATA, 'backup'), { recursive: true });
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch (e) { return {} } };
const CFG = Object.assign({
  port: 7070,
  host: '127.0.0.1',
  sbUrl: '',          // endereço do Supabase DESTA empresa (tela de primeira configuração)
  sbKey: '',          // chave pública (anon) do Supabase desta empresa
  syncSeg: 15
}, readJson(path.join(DATA, 'config.json')));

/* ---------- log ---------- */
const LOGF = path.join(DATA, 'log.txt');
function log(...a) {
  const s = new Date().toLocaleString('pt-BR') + '  ' + a.join(' ');
  console.log(s);
  try { if (fs.existsSync(LOGF) && fs.statSync(LOGF).size > 2e6) fs.renameSync(LOGF, LOGF + '.old'); fs.appendFileSync(LOGF, s + '\n') } catch (e) { }
}
/* erro ao LIGAR (antes de abrir a porta) ia só para a tela escondida: agora fica no log.txt e no erro-ao-ligar.txt */
let LIGADO = false;
process.on('uncaughtException', e => {
  log('ERRO', (e && e.stack) || e);
  if (!LIGADO) { try { fs.writeFileSync(path.join(DATA, 'erro-ao-ligar.txt'), new Date().toLocaleString('pt-BR') + '\n' + ((e && e.stack) || e)) } catch (x) { } process.exit(1) }
});
/* computador CAIXA da rede: não tem banco nem sincroniza; só repassa para o servidor da loja */
if (CFG.modo == 'caixa') { require('./caixa')({ CFG, DATA, ROOT, log, J: x => { try { return JSON.parse(x) } catch (e) { return null } }, cfgFile: path.join(DATA, 'config.json') }); return }
const REDE = !!(CFG.rede || CFG.lan);   // outros caixas da loja ligados neste servidor

/* ---------- restaurar backup pedido pela Gestão (feito antes de abrir o banco) ---------- */
(() => {
  const mk = path.join(DATA, 'restaurar.json'); if (!fs.existsSync(mk)) return;
  try {
    const r = JSON.parse(fs.readFileSync(mk, 'utf8')), src = r.arquivo, dst = path.join(DATA, 'pdv.db');
    if (src && fs.existsSync(src)) {
      const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      if (fs.existsSync(dst)) fs.copyFileSync(dst, path.join(DATA, 'backup', 'antes-de-restaurar-' + t + '.db'));
      for (const x of ['-wal', '-shm']) try { fs.unlinkSync(dst + x) } catch (e) { }
      fs.copyFileSync(src, dst); log('BACKUP RESTAURADO:', path.basename(src), '(o banco anterior ficou em backup/antes-de-restaurar-' + t + '.db)');
    } else log('restaurar: arquivo não encontrado', src);
  } catch (e) { log('restaurar falhou:', e.message) }
  try { fs.unlinkSync(mk) } catch (e) { }
})();
/* ---------- banco local ---------- */
const db = new DatabaseSync(path.join(DATA, 'pdv.db'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
create table if not exists kv(k text primary key, v text);
create table if not exists products(id text primary key, data text not null, updated_at text);
create table if not exists clients(id text primary key, data text not null, updated_at text);
create table if not exists config(id text primary key, data text not null, updated_at text);
create table if not exists orders(id text primary key, data text not null, updated_at text, dirty integer default 0);
create table if not exists caixa(id text primary key, data text not null, updated_at text, dirty integer default 0);
create table if not exists outbox(seq integer primary key autoincrement, kind text not null, ref text not null, payload text not null, created text not null, tries integer default 0, err text);`);
db.exec(`create table if not exists operadores(id text primary key, data text not null, updated_at text, dirty integer default 0);
create table if not exists mov_estoque(id text primary key, data text not null, updated_at text, dirty integer default 0);
create table if not exists fiado(id text primary key, data text not null, updated_at text, dirty integer default 0);
create table if not exists contas(id text primary key, data text not null, updated_at text, dirty integer default 0);
create table if not exists lotes(id text primary key, data text not null, updated_at text, dirty integer default 0);`);
function addCol(t, c, def) { if (!db.prepare(`pragma table_info(${t})`).all().some(r => r.name == c)) db.exec(`alter table ${t} add column ${c} ${def}`) }
db.exec('create table if not exists fotos(id text primary key, img text not null, v text)');
addCol('products', 'dirty', 'integer default 0'); addCol('clients', 'dirty', 'integer default 0'); addCol('config', 'dirty', 'integer default 0');
const J = s => { try { return JSON.parse(s) } catch (e) { return null } };
const kvGet = k => { const r = db.prepare('select v from kv where k=?').get(k); return r ? J(r.v) : null };
const kvSet = (k, v) => db.prepare('insert into kv(k,v) values(?,?) on conflict(k) do update set v=excluded.v').run(k, JSON.stringify(v));
const kvDel = k => db.prepare('delete from kv where k=?').run(k);
function tx(fn) { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e } }
const rows = (t, where = '', ...a) => db.prepare(`select data from ${t} ${where}`).all(...a).map(r => J(r.data)).filter(Boolean);
const one = (t, id) => { const r = db.prepare(`select data, dirty from ${t} where id=?`).get(id); return r ? { data: J(r.data), dirty: r.dirty } : null };
const r2 = n => Math.round((+n || 0) * 100) / 100;
const brl = n => 'R$ ' + (+n || 0).toFixed(2).replace('.', ',');
const digits = v => String(v ?? '').replace(/\D/g, '');
/* grava localmente marcando "mudou aqui, falta enviar" */
function saveRow(t, obj) { db.prepare(`insert into ${t}(id,data,updated_at,dirty) values(?,?,?,1) on conflict(id) do update set data=excluded.data, updated_at=excluded.updated_at, dirty=1`).run(obj.id, JSON.stringify(obj), nowIso()) }
/* grava localmente sem marcar (ex.: estoque que já vai num movimento) */
function setData(t, id, obj) { db.prepare(`update ${t} set data=? where id=?`).run(JSON.stringify(obj), id) }
function outbox(kind, ref, payload) { db.prepare('insert into outbox(kind,ref,payload,created) values(?,?,?,?)').run(kind, ref, JSON.stringify(payload), nowIso()) }
const nowIso = () => new Date().toISOString();
/* fotos dos produtos: ficam numa tabela à parte (o PDV busca só quando mostra) */
const fotoV = img => crypto.createHash('sha1').update(img).digest('hex').slice(0, 10);
function setFoto(id, img) {
  if (img) { const v = fotoV(img); db.prepare('insert into fotos(id,img,v) values(?,?,?) on conflict(id) do update set img=excluded.img, v=excluded.v').run(id, img, v); return v }
  db.prepare('delete from fotos where id=?').run(id); return null;
}
if (!kvGet('fotos_v1')) { kvDel('cur_products'); kvSet('fotos_v1', true) }
const stk = p => (p.est === '' || p.est == null || isNaN(+p.est)) ? null : +p.est;
const r3 = n => Math.round((+n || 0) * 1000) / 1000;

/* instalação feita antes do Supabase ser configurável (cliente original): mantém o mesmo banco online */
const LEG_URL = 'https://jfhyyizuziyxumtiebdn.supabase.co';
if ((!CFG.sbUrl || (CFG.sbUrl == LEG_URL && !CFG.sbKey)) && kvGet('owner')) {
  const leg = { fakeDom: '@mercadomezzomo1-cmd.github.io', sbUrl: 'https://jfhyyizuziyxumtiebdn.supabase.co', sbKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpmaHl5aXp1eml5eHVtdGllYmRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMDY0NDAsImV4cCI6MjEwNzY4MjQ0MH0.-PCi3sXeLUeMh5RAPpLcNDLcbgCVRcntZB2IwHeDSvM' };
  Object.assign(CFG, leg); try { const f = path.join(DATA, 'config.json'); fs.writeFileSync(f, JSON.stringify({ ...readJson(f), ...leg }, null, 2)) } catch (e) { }
  log('configuração: Supabase da instalação anterior mantido');
}
const sbOk = () => /^https?:\/\/[^/]+/.test(CFG.sbUrl || '') && !!CFG.sbKey;

/* ---------- Supabase (REST) ---------- */
let S = kvGet('session');            // {access_token, refresh_token, expires_at, user}
let online = false, lastSync = kvGet('lastSync'), lastErr = '', syncing = null, needLogin = !S;
class NetErr extends Error { }
async function raw(url, opt = {}, ms = 20000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ac.signal }) }
  catch (e) { throw new NetErr(e.cause && e.cause.code || e.message) }
  finally { clearTimeout(t) }
}
async function auth(grant, body) {
  const r = await raw(`${CFG.sbUrl}/auth/v1/token?grant_type=${grant}`, { method: 'POST', headers: { apikey: CFG.sbKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error_description || j.msg || j.message || ('HTTP ' + r.status)); e.status = r.status; e.auth = true; throw e }
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in || 3600) * 1000, user: { id: j.user && j.user.id, email: j.user && j.user.email } };
}
async function token(force) {
  if (!S) { const e = new Error('Entre com a conta da loja.'); e.login = true; throw e }
  if (force || Date.now() > S.expires_at - 90000) {
    try { S = await auth('refresh_token', { refresh_token: S.refresh_token }); kvSet('session', S) }
    catch (e) { if (e.auth && e.status >= 400 && e.status < 500) { needLogin = true; e.login = true; e.message = 'A sessão expirou. Entre de novo com a conta da loja.' } throw e }
  }
  return S.access_token;
}
async function api(p, { method = 'GET', body, prefer, tk } = {}) {
  for (let i = 0; i < 2; i++) {
    const t = tk || await token(i > 0);
    const h = { apikey: CFG.sbKey, Authorization: 'Bearer ' + t, 'content-type': 'application/json' };
    if (prefer) h.Prefer = prefer;
    const r = await raw(CFG.sbUrl + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (r.status == 401 && i == 0 && !tk) continue;
    const txt = await r.text(), j = txt ? J(txt) : null;
    if (!r.ok) { const e = new Error((j && (j.message || j.error_description || j.msg)) || ('HTTP ' + r.status)); e.status = r.status; throw e }
    return j;
  }
}

/* ---------- sincronização ---------- */
const PULL = [['config', null], ['products', null], ['clients', null], ['caixa', 45], ['orders', 60], ['operadores', null, true], ['fiado', null, true], ['mov_estoque', 90, true], ['contas', null, true], ['lotes', null, true]];
const avisado = {};
function pendingDeltas() {
  const m = {};
  for (const r of db.prepare("select payload from outbox where err is null").all()) {
    const p = J(r.payload); for (const [pid, d] of Object.entries((p && p.deltas) || {})) m[pid] = (m[pid] || 0) + d;
  }
  return m;
}
function applyRows(t, list) {
  const pend = t == 'products' ? pendingDeltas() : null;
  const up = db.prepare(`insert into ${t}(id,data,updated_at) values(?,?,?) on conflict(id) do update set data=excluded.data, updated_at=excluded.updated_at`);
  const dirty = db.prepare(`select dirty from ${t} where id=?`);
  tx(() => {
    for (const r of list) {
      if (!r || !r.id || !r.data) continue;
      if (dirty) { const d = dirty.get(r.id); if (d && d.dirty) continue }   // mudança local ainda não enviada
      let d = r.data;
      if (t == 'products') { d = { ...d }; d.temFoto = !!d.img; d.fv = setFoto(r.id, d.img || ''); delete d.img; const s = stk(d); if (s !== null && pend[r.id]) d.est = Math.max(0, r3(s - pend[r.id])) }
      up.run(r.id, JSON.stringify(d), r.updated_at || null);
    }
  });
}
async function pullTable(t, days) {
  const cur = kvGet('cur_' + t);
  const since = cur ? new Date(Date.parse(cur) - 120000).toISOString() : (days ? new Date(Date.now() - days * 864e5).toISOString() : null);
  let off = 0, max = cur, n = 0;
  for (; ;) {
    const q = `/rest/v1/${t}?select=id,data,updated_at&order=updated_at.asc.nullsfirst,id.asc&limit=1000&offset=${off}` + (since ? `&updated_at=gte.${encodeURIComponent(since)}` : '');
    const list = await api(q) || [];
    applyRows(t, list);
    for (const r of list) if (r.updated_at && (!max || r.updated_at > max)) max = r.updated_at;
    off += list.length; n += list.length;
    if (list.length < 1000) break;
  }
  if (max && max !== cur) kvSet('cur_' + t, max);
  return n;
}
async function delCheck(t) {
  const ids = new Set(); let off = 0;
  for (; ;) { const l = await api(`/rest/v1/${t}?select=id&order=id.asc&limit=5000&offset=${off}`) || []; l.forEach(r => ids.add(r.id)); off += l.length; if (l.length < 5000) break }
  const loc = db.prepare(`select id from ${t}`).all().map(r => r.id).filter(id => !ids.has(id));
  if (loc.length) { const d = db.prepare(`delete from ${t} where id=?`); tx(() => loc.forEach(id => d.run(id))); log('removidos', t, loc.length) }
}
async function push() {
  const ops = db.prepare('select * from outbox where err is null order by seq').all();
  let sent = 0;
  for (const op of ops) {
    const p = J(op.payload);
    try {
      if (op.kind == 'faturar') await api('/rest/v1/rpc/pdv_faturar', { method: 'POST', body: { p_id: p.id, p_data: p.data } });
      else if (op.kind == 'caixa') await api('/rest/v1/caixa?on_conflict=id', { method: 'POST', body: { id: p.id, data: p, updated_at: p.date }, prefer: 'resolution=merge-duplicates,return=minimal' });
      else if (op.kind == 'estornar') await api('/rest/v1/rpc/pdv_estornar', { method: 'POST', body: { p_id: p.id, p_canc: p.canc } });
      else if (op.kind == 'estoque') await api('/rest/v1/rpc/pdv_mov_estoque', { method: 'POST', body: { p_mov: p.mov } });
      else if (op.kind == 'produto') await api('/rest/v1/rpc/pdv_salvar_produto', { method: 'POST', body: { p_id: p.id, p_data: p.data } });
      else if (op.kind == 'merge') await api('/rest/v1/rpc/pdv_merge', { method: 'POST', body: { p_tab: p.tab, p_id: p.id, p_data: p.data } });
      else if (op.kind == 'parte') await api('/rest/v1/rpc/pdv_parte', { method: 'POST', body: { p_id: p.id, p_parc: p.parc, p_patch: p.patch } });
      else if (op.kind == 'mp') await api('/rest/v1/rpc/pdv_pedido_mp', { method: 'POST', body: { p_id: p.id, p_mp: p.mp, p_st: p.st || null } });
      else if (op.kind == 'status') await api('/rest/v1/rpc/pdv_pedido_status', { method: 'POST', body: { p_id: p.id, p_st: p.st } });
      else if (op.kind == 'delped') {
        try { await api('/rest/v1/rpc/pdv_excluir_pedido', { method: 'POST', body: { p_id: p.id } }) }
        catch (e) { if (e.status == 404 || /pdv_excluir_pedido|function/i.test(e.message)) await api(`/rest/v1/orders?id=eq.${encodeURIComponent(p.id)}`, { method: 'DELETE', prefer: 'return=minimal' }); else throw e }
      }
      else if (op.kind == 'del') await api(`/rest/v1/${p.tab}?id=eq.${encodeURIComponent(p.id)}`, { method: 'DELETE', prefer: 'return=minimal' });
      tx(() => { db.prepare('delete from outbox where seq=?').run(op.seq); limpaDirty(op) });
      sent++;
    } catch (e) {
      if (e instanceof NetErr || e.login) throw e;
      if (!e.status || e.status >= 500 || e.status == 429) { db.prepare('update outbox set tries=tries+1 where seq=?').run(op.seq); throw e }
      db.prepare('update outbox set err=?, tries=tries+1 where seq=?').run(e.message, op.seq);
      log('RECUSADO pelo servidor', op.kind, p.id, e.message);
    }
  }
  if (sent) log('enviados', sent);
}
const TAB_OP = { parte: 'orders', mp: 'orders', faturar: 'orders', estornar: 'orders', status: 'orders', caixa: 'caixa', estoque: 'mov_estoque', produto: 'products' };
function limpaDirty(op) {
  const p = J(op.payload) || {}, t = op.kind == 'merge' ? p.tab : TAB_OP[op.kind];
  if (!t || !['orders', 'caixa', 'mov_estoque', 'products', 'clients', 'operadores', 'fiado', 'config', 'contas', 'lotes'].includes(t)) return;
  if (!db.prepare('select 1 from outbox where ref=? and err is null').get(op.ref)) db.prepare(`update ${t} set dirty=0 where id=?`).run(op.ref);
}
async function syncNow() {
  if (syncing) return syncing;
  if (!S || !sbOk()) { online = false; return }
  syncing = (async () => {
    try {
      await push();
      for (const [t, d, opc] of PULL) {
        try { await pullTable(t, d) }
        catch (e) { if (opc && !(e instanceof NetErr) && (e.status == 404 || /does not exist|schema cache|PGRST20/i.test(e.message))) { if (!avisado[t]) { log(`tabela "${t}" não existe no Supabase: rode o supabase.sql`); avisado[t] = 1 } continue } throw e }
      }
      if (Date.now() - (kvGet('lastDel') || 0) > 10 * 60000) { await delCheck('products'); await delCheck('clients'); kvSet('lastDel', Date.now()) }
      try { await mpApp() } catch (e) { log('Mercado Pago:', e.message) }
      online = true; lastErr = ''; lastSync = nowIso(); kvSet('lastSync', lastSync); needLogin = false;
    } catch (e) {
      if (e instanceof NetErr) { if (online) log('sem internet:', e.message); online = false; lastErr = 'Sem internet' }
      else { online = !e.login; lastErr = e.message; log('erro na sincronização:', e.message) }
    } finally { syncing = null }
  })();
  return syncing;
}
let syncTimer = setInterval(syncNow, CFG.syncSeg * 1000);
const soon = () => setTimeout(() => { if (syncing) syncing.then(() => setTimeout(syncNow, 200)); else syncNow() }, 300);

/* ---------- operações do caixa ---------- */
function faturar(id, data, ctx = {}) {
  const fid = data && data.fat && data.fat.id;
  if (!id || !fid || !Array.isArray(data.items) || !data.items.length) throw new Error('Faturamento inválido');
  const r = tx(() => {
    const cur = one('orders', id), old = cur && cur.data;
    if (old && old.fat && old.fat.id == fid) return { ...old, _dup: true };
    if (old && old.fat) throw new Error('Este pedido já foi faturado');
    if (old && old.st == 'canc') throw new Error('Pedido cancelado não pode ser faturado');
    const agg = l => { const m = {}; (l || []).forEach(i => { if (i && i.pid) m[i.pid] = (m[i.pid] || 0) + (+i.q || 0) }); return m };
    const n = agg(data.items), o = agg(old && old.items), deltas = {};
    for (const pid of new Set([...Object.keys(n), ...Object.keys(o)])) { const d = r3((n[pid] || 0) - (o[pid] || 0)); if (d) deltas[pid] = d }
    const gp = db.prepare('select data from products where id=?'), sp = db.prepare('update products set data=? where id=?');
    for (const [pid, d] of Object.entries(deltas)) {
      const pr = gp.get(pid); if (!pr) continue; const p = J(pr.data), s = stk(p); if (s === null) continue;
      p.est = Math.max(0, r3(s - d)); sp.run(JSON.stringify(p), pid);
    }
    if (ctx.op) data.fat = { ...data.fat, op: ctx.op.n, opid: ctx.op.id };
    const fv = r2((data.pags || []).filter(g => g.f == 'Fiado').reduce((s, g) => s + (+g.v || 0), 0));
    let fe = null;
    if (fv > 0) {
      const cid = data.cid_fiado, c = cid && one('clients', cid);
      if (!c) throw new Error('Escolha o cliente (F6) para vender no fiado.');
      const lim = +c.data.limite || 0, saldo = saldoFiado(cid);
      if ((!lim || saldo + fv > lim + 0.004) && !ctx.aut) throw new Error(`FIADO_LIMITE: ${c.data.n} deve ${brl(saldo)}; com esta compra fica ${brl(saldo + fv)}${lim ? ' e o limite é ' + brl(lim) : ' e não tem limite de fiado cadastrado'}.`);
      fe = { id: crypto.randomUUID(), date: nowIso(), cid, cn: c.data.n, tipo: 'compra', valor: fv, venda: id, op: ctx.op ? ctx.op.n : '', aut: ctx.aut || '' };
      data.fiado = { cid, cn: c.data.n, valor: fv };
    }
    const novo = old ? { ...old, ...data, id, cid: old.cid, canal: old.canal || 'app' } : { ...data, id };
    db.prepare('insert into orders(id,data,updated_at,dirty) values(?,?,?,1) on conflict(id) do update set data=excluded.data, updated_at=excluded.updated_at, dirty=1').run(id, JSON.stringify(novo), nowIso());
    db.prepare('insert into outbox(kind,ref,payload,created) values(?,?,?,?)').run('faturar', id, JSON.stringify({ id, data, deltas }), nowIso());
    if (fe) { saveRow('fiado', fe); outbox('merge', fe.id, { tab: 'fiado', id: fe.id, data: fe }) }
    return novo;
  });
  if (r._dup) { delete r._dup; return r }
  log('venda faturada', id.slice(-6), 'R$', data.total);
  soon(); return r;
}
const TIPOS = ['abertura', 'suprimento', 'sangria', 'despesa'];
function movimento(m) {
  if (!m || !TIPOS.includes(m.tipo) || !(+m.valor >= 0)) throw new Error('Movimento inválido');
  const id = m.id || crypto.randomUUID(), d = { id, date: m.date || nowIso(), tipo: m.tipo, valor: Math.round(+m.valor * 100) / 100, desc: String(m.desc || '').slice(0, 200), ...(m.pdv ? { pdv: String(m.pdv).slice(0, 40) } : {}) };
  tx(() => {
    db.prepare('insert into caixa(id,data,updated_at,dirty) values(?,?,?,1) on conflict(id) do update set data=excluded.data, dirty=1').run(id, JSON.stringify(d), d.date);
    db.prepare('insert into outbox(kind,ref,payload,created) values(?,?,?,?)').run('caixa', id, JSON.stringify(d), nowIso());
  });
  log('caixa', d.tipo, d.valor); soon(); return d;
}
function hoje0() { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
function dia() {
  const t0 = hoje0();
  return {
    mv: rows('caixa').filter(m => new Date(m.date) >= t0),
    os: rows('orders', `where data like '%"fat":%'`).filter(o => o.fat && new Date(o.fat.date) >= t0),
    fi: rows('fiado').filter(f => new Date(f.date) >= t0)
  };
}
function pend() {
  const lim = Date.now() - 20 * 864e5;
  return rows('orders', `where data not like '%"fat":%'`).filter(o => (o.st == 'novo' || o.st == 'conf' || (!o.st && !o.done)) && o.canal != 'balcao' && Date.parse(o.date) >= lim);
}
function status() {
  const ob = db.prepare('select count(*) n from outbox where err is null').get().n;
  const errs = db.prepare('select seq,kind,ref,payload,err from outbox where err is not null order by seq').all().map(r => { const p = J(r.payload) || {}; return { seq: r.seq, kind: r.kind, ref: r.ref, err: r.err, total: p.data ? (p.data.total ?? p.data.valor ?? null) : (p.valor ?? null), desc: p.mov ? p.mov.tipo + ' ' + p.mov.n : p.tab ? p.tab : p.data && p.data.n ? p.data.n : '' } });
  return { local: true, produto: 'AdaptaSys Mercado', versao: VERSAO, needSetup: !sbOk(), user: S && S.user, needLogin, online, lastSync, lastErr, outbox: ob, errs, products: db.prepare('select count(*) n from products').get().n, prn: prnCfg(), regras: regras(), ops: opsAtivos().length, fiscal: FISCAL.estado(), integridade: INTEG.ok === false ? INTEG : undefined, version: 4 };
}

/* versão instalada (vem do manifest.json do pacote): as telas abertas comparam e se recarregam sozinhas depois de uma atualização */
const VERSAO = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).versao || '' } catch (e) { return '' } })();
/* ---------- regras da loja ---------- */
const REGRAS0 = { cancItem: true, cancVenda: true, descMax: 5, precoMenor: true, cadProduto: true, pinTroca: false, semPin: false };
const regras = () => Object.assign({}, REGRAS0, kvGet('regras') || {});

/* ---------- operadores (PIN) e autorização do gerente ---------- */
const SESS = new Map(), AUTHS = new Map(); let pinFalhas = [];
const hashPin = (pin, salt) => crypto.pbkdf2Sync(String(pin), salt, 20000, 32, 'sha256').toString('hex');
const opsAtivos = () => rows('operadores').filter(o => o.ativo !== false);
const opPub = o => ({ id: o.id, n: o.n, nivel: o.nivel || 'caixa', ativo: o.ativo !== false });
function pinBloqueado() { pinFalhas = pinFalhas.filter(t => Date.now() - t < 60000); if (pinFalhas.length >= 5) throw new Error('Muitas senhas erradas. Espere um minuto.') }
function opSess(b) {
  const s = b && b.token && SESS.get(b.token);
  if (!s || Date.now() - s.t > 16 * 3600e3) throw new Error('OPERADOR: entre com seu operador.');
  s.t = Date.now(); return s.op;
}
function autDe(b) { const a = b && b.auth && AUTHS.get(b.auth); if (a && a.exp > Date.now()) { AUTHS.delete(b.auth); return a.n } return '' }
function gerente(b, acao) {
  const op = opSess(b); if (op.nivel == 'gerente') return { op, aut: op.n };
  const n = autDe(b); if (n) return { op, aut: n };
  throw new Error('GERENTE: ' + (acao || 'esta ação') + ' precisa da senha do gerente.');
}
function ctxRegra(b, regra, acao) { return regras()[regra] ? gerente(b, acao) : { op: opSess(b), aut: autDe(b) } }
function salvarOperador(b) {
  const o = b.op || {}, ativos = opsAtivos();
  if (ativos.length) gerente(b, 'cadastrar operador');
  const n = String(o.n || '').trim(); if (!n) throw new Error('Informe o nome do operador.');
  const id = o.id || crypto.randomUUID(), cur = one('operadores', id), old = cur ? cur.data : null;
  const nivel = ativos.length ? (o.nivel == 'gerente' ? 'gerente' : 'caixa') : 'gerente';
  const d = { ...(old || { id, date: nowIso() }), n, nivel, ativo: o.ativo !== false };
  if (o.pin) { if (!/^\d{4,8}$/.test(String(o.pin))) throw new Error('O PIN precisa ter de 4 a 8 números.'); d.salt = crypto.randomBytes(12).toString('hex'); d.hash = hashPin(o.pin, d.salt) }
  if (!d.hash) throw new Error('Defina um PIN para o operador.');
  if (d.nivel != 'gerente' || !d.ativo) { if (!opsAtivos().some(x => x.id != id && x.nivel == 'gerente')) throw new Error('A loja precisa ter pelo menos um gerente ativo.') }
  const outros = opsAtivos().filter(x => x.id != id);
  if (o.pin && outros.some(x => x.hash && hashPin(o.pin, x.salt) == x.hash)) throw new Error('Esse PIN já é de outro operador. Escolha outro.');
  tx(() => { saveRow('operadores', d); outbox('merge', id, { tab: 'operadores', id, data: d }) });
  log('operador salvo', n, d.nivel); soon(); return opPub(d);
}

/* ---------- produtos ---------- */
function salvarProdutoTx(p, parcial) {
  const id = p.id || crypto.randomUUID(), cur = one('products', id), old = cur && cur.data;
  if (parcial && !old) throw new Error('Produto não encontrado');
  const c = {};
  const has = k => Object.prototype.hasOwnProperty.call(p, k);
  if (!parcial || has('n')) { c.n = String(p.n || '').trim(); if (!c.n) throw new Error('Informe o nome do produto.') }
  if (!parcial || has('p')) { c.p = r2(p.p); if (!(c.p >= 0) || p.p === '' || p.p == null) throw new Error('Informe o preço de venda.') }
  if (!parcial || has('u')) c.u = ['un', 'kg', 'g', 'L', 'pct', 'cx'].includes(p.u) ? p.u : 'un';
  if (!parcial || has('c')) c.c = String(p.c || '').trim().toUpperCase();
  if (has('dep')) c.dep = String(p.dep || '').trim().toUpperCase().slice(0, 60);
  if (c.c && !c.dep && !(old && old.dep && !has('dep'))) c.dep = DEPCAT.depDe(c.c, DEPCAT.estrutura(empresa()));   // categoria conhecida: o departamento vem junto
  if (has('marca')) {   // marca: reaproveita a grafia que já existe (Nestlé = NESTLE = nestle)
    let m = String(p.marca || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (m) { const ex = db.prepare("select distinct json_extract(data,'$.marca') m from products where json_extract(data,'$.marca') <> ''").all().map(x => x.m).find(x => x && x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase() == m.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()); if (ex) m = ex }
    c.marca = m;
  }
  if (!parcial || has('cod')) c.cod = String(p.cod || '').trim();
  if (!parcial || has('bar')) c.bar = String(p.bar || '').trim();
  if (!parcial || has('ncm')) c.ncm = digits(p.ncm).slice(0, 8);
  if (!parcial || has('custo')) c.custo = p.custo === '' || p.custo == null ? null : r2(p.custo);
  if (!parcial || has('min')) c.min = p.min === '' || p.min == null ? null : r3(p.min);
  if (has('forn')) c.forn = p.forn;
  if (has('rap')) c.rap = !!p.rap;
  if (has('mk')) c.mk = p.mk === '' || p.mk == null ? null : Math.max(0, Math.min(1000, +p.mk || 0));
  if (has('csosn')) c.csosn = ['102', '500'].includes(String(p.csosn)) ? String(p.csosn) : '';
  if (has('cest')) c.cest = digits(p.cest).slice(0, 7);
  if (has('orig')) c.orig = Math.max(0, Math.min(8, +p.orig || 0));
  if (has('rapOrd')) c.rapOrd = p.rapOrd == null ? null : +p.rapOrd;
  if (has('parc')) {   // Estoque: Loja ('') ou Parceiro X (o produto é do parceiro; a nota dele é emitida por ele)
    const id = String(p.parc || ''), l = kvGet('parceiros') || [], x = l.find(z => z.id == id);
    if (id && !x) throw new Error('Parceiro não encontrado. Abra Configurações › Parceiros com internet para atualizar a lista.');
    c.parc = id; c.parcN = x ? x.nome : '';
  }
  let img;
  if (has('img')) { img = String(p.img || ''); if (img && !/^data:image\/(jpeg|png|webp);base64,/.test(img)) throw new Error('Foto inválida.'); if (img.length > 400000) throw new Error('Foto grande demais.'); c.temFoto = !!img; c.fv = setFoto(id, img) }
  if (c.bar) { const dup = db.prepare("select json_extract(data,'$.n') n from products where id<>? and json_extract(data,'$.bar')=?").get(id, c.bar); if (dup) throw new Error(`O código de barras ${c.bar} já é do produto "${dup.n}".`) }
  let data, send;
  if (!old) { data = { id, ...c, est: p.est === '' || p.est == null ? null : Math.max(0, r3(p.est)) }; send = { ...data } }
  else { data = { ...old, ...c }; send = { ...c } }
  delete send.temFoto; delete send.fv; if (img !== undefined) send.img = img;
  saveRow('products', data); outbox('produto', id, { id, data: send });
  return data;
}
/* estrutura DEPARTAMENTO › CATEGORIA da loja (fica nos ajustes da loja e vai para o app) */
function limparTax(t) {
  const l = []; for (const x of (Array.isArray(t) ? t : []).slice(0, 40)) {
    const d = String(x && x.d || '').trim().toUpperCase().slice(0, 60); if (!d || l.some(y => y.d == d)) continue;
    l.push({ d, c: [...new Set((Array.isArray(x.c) ? x.c : []).map(c => String(c || '').trim().toUpperCase().slice(0, 60)).filter(Boolean))].slice(0, 120) });
  }
  return l;
}
function gravarTax(tax) {
  const cur = one('config', 'empresa'), old = (cur && cur.data) || {};
  tx(() => { saveRow('config', { id: 'empresa', ...old, tax }); outbox('merge', 'empresa', { tab: 'config', id: 'empresa', data: { tax } }) }); soon();
}
function garantirCategoria(dep, c) {
  if (!dep || !c) return;
  const tax = limparTax(DEPCAT.estrutura(empresa())), sem = DEPCAT.sem;
  if (tax.some(t => t.c.some(x => sem(x) == sem(c)))) { if (!(empresa().tax || []).length) gravarTax(tax); return }
  let t = tax.find(x => sem(x.d) == sem(dep)); if (!t) { t = { d: dep, c: [] }; tax.push(t) }
  t.c.push(c); gravarTax(tax); log('categoria nova', dep, '›', c);
}
/* classificar vários produtos de uma vez (prévia aprovada na Gestão) */
function classificarProdutos(b) {
  const ctx = gerente(b, 'classificar produtos'), it = (Array.isArray(b.itens) ? b.itens : []).filter(i => i && i.id && i.c);
  const n = tx(() => { let k = 0; for (const i of it) { if (!one('products', i.id)) continue; salvarProdutoTx({ id: i.id, c: i.c, dep: i.dep || '' }, true); k++ } return k });
  if (!(empresa().tax || []).length) gravarTax(limparTax(DEPCAT.estrutura(empresa())));
  for (const i of it) try { garantirCategoria(String(i.dep || '').toUpperCase(), String(i.c).toUpperCase()) } catch (e) { }
  log('produtos classificados', n, 'por', ctx.op.n); soon(); return { n };
}
/* vendas e margem por departamento e categoria (vendas faturadas no período, sem as canceladas) */
function relDepartamentos(q) {
  const de = q.get('de') || hojeLocal(), ate = q.get('ate') || de;
  const t0 = new Date(de + 'T00:00:00'), t1 = new Date(ate + 'T23:59:59.999');
  const P = Object.fromEntries(rows('products').map(p => [p.id, p])), tax = DEPCAT.estrutura(empresa());
  const deps = {}; let vendas = 0;
  for (const o of rows('orders', `where data like '%"fat":%'`)) {
    if (!o.fat || o.st == 'canc') continue; const d = new Date(o.fat.date); if (d < t0 || d > t1) continue; vendas++;
    const its = o.items || [], bruto = its.reduce((s, i) => s + (+i.p || 0) * (+i.q || 0), 0), liq = (+o.total || 0) - (+o.taxa || 0), f = bruto > 0 ? Math.min(1, Math.max(0, liq / bruto)) : 1;
    for (const i of its) {
      const p = P[i.pid] || {}, c = p.c || 'SEM CATEGORIA', dep = p.dep || DEPCAT.depDe(c, tax) || 'SEM DEPARTAMENTO';
      const v = (+i.p || 0) * (+i.q || 0) * f, cu = +p.custo > 0 ? +p.custo * (+i.q || 0) : null;
      const D = deps[dep] = deps[dep] || { dep, venda: 0, custo: 0, semCusto: 0, itens: 0, cats: {} }, C = D.cats[c] = D.cats[c] || { c, venda: 0, custo: 0, semCusto: 0, itens: 0 };
      for (const x of [D, C]) { x.venda += v; x.itens += +i.q || 0; if (cu == null) x.semCusto += v; else x.custo += cu }
    }
  }
  const fim = x => ({ ...x, venda: r2(x.venda), custo: r2(x.custo), semCusto: r2(x.semCusto), lucro: r2(x.venda - x.semCusto - x.custo), margem: x.venda - x.semCusto > 0 ? r2((x.venda - x.semCusto - x.custo) / (x.venda - x.semCusto) * 100) : null });
  const l = Object.values(deps).map(D => ({ ...fim(D), cats: Object.values(D.cats).map(fim).sort((a, b) => b.venda - a.venda) })).sort((a, b) => b.venda - a.venda);
  const tot = l.reduce((s, x) => s + x.venda, 0);
  return { de, ate, vendas, total: r2(tot), deps: l.map(x => ({ ...x, part: tot ? r2(x.venda / tot * 100) : 0 })) };
}
function salvarProduto(b) {
  const p = b.p || {}, novo = !p.id;
  const soRap = !novo && b.parcial && Object.keys(p).every(k => ['id', 'rap', 'rapOrd'].includes(k));
  const ctx = soRap ? { op: opSess(b), aut: '' } : novo ? ctxRegra(b, 'cadProduto', 'cadastrar produto') : gerente(b, 'alterar produto');
  const r = tx(() => salvarProdutoTx(p, !novo && b.parcial));
  try { garantirCategoria(r.dep, r.c) } catch (e) { log('estrutura de categorias:', e.message) }
  log(novo ? 'produto cadastrado' : 'produto alterado', r.n, 'por', ctx.op.n, ctx.aut && ctx.aut != ctx.op.n ? '(aut. ' + ctx.aut + ')' : ''); soon(); return r;
}

/* ---------- movimentos de estoque ---------- */
const TIPOS_EST = { entrada: 1, ajuste: 1, perda: -1, inventario: 0, devolucao: 1, saida: -1, devforn: -1 };
function movEstoqueTx(m, ctx, now) {
  if (!(m.tipo in TIPOS_EST)) throw new Error('Tipo de movimento inválido');
  const cur = one('products', m.pid); if (!cur) throw new Error('Produto não encontrado');
  const p = cur.data, s = stk(p) ?? 0;
  let d;
  if (m.tipo == 'inventario') { if (!(+m.contado >= 0) || m.contado === '' || m.contado == null) throw new Error('Informe a quantidade contada de ' + p.n); d = r3(+m.contado - s) }
  else if (m.tipo == 'ajuste') d = r3(+m.q);
  else { d = r3(Math.abs(+m.q) * TIPOS_EST[m.tipo]); if (!d) throw new Error('Informe a quantidade de ' + p.n) }
  if (!d && m.tipo != 'inventario') throw new Error('Informe a quantidade de ' + p.n);
  p.est = Math.max(0, r3(s + d)); if (+m.custo > 0) p.custo = r2(m.custo);
  setData('products', p.id, p);
  const mov = { id: crypto.randomUUID(), date: now, pid: p.id, n: p.n, tipo: m.tipo, q: d, ant: s, est: p.est, ...(+m.custo > 0 ? { custo: r2(m.custo) } : {}), doc: String(m.doc || '').slice(0, 120), chave: m.chave || '', obs: String(m.obs || '').slice(0, 200), op: ctx.op.n, aut: ctx.aut && ctx.aut != ctx.op.n ? ctx.aut : '' };
  saveRow('mov_estoque', mov); outbox('estoque', mov.id, { mov, deltas: { [p.id]: -d } });
  return mov;
}
function estoque(b) {
  const ctx = gerente(b, 'mexer no estoque'), list = b.movs || [];
  if (!list.length) throw new Error('Nenhum item.');
  const now = nowIso(), r = tx(() => list.map(m => movEstoqueTx(m, ctx, now)));
  log('estoque', r.length, 'movimento(s) por', ctx.op.n); soon(); return r;
}
function entrada(b) {
  const ctx = gerente(b, 'dar entrada de nota'), nota = b.nota || {}, itens = b.itens || [];
  if (!itens.length) throw new Error('Nenhum item na nota.');
  if (nota.chave && db.prepare("select 1 from mov_estoque where json_extract(data,'$.chave')=? limit 1").get(nota.chave)) throw new Error('Esta nota já foi lançada no estoque.');
  const now = nowIso(), doc = ('NF ' + (nota.numero || '') + ' · ' + (nota.fornecedor || '')).trim(), criados = {};
  const r = tx(() => itens.map(it => {
    let pid = it.pid;
    if (!pid) {
      if (!it.novo) throw new Error('Escolha o produto de "' + (it.xProd || '') + '"');
      // o código de barras já é de um produto da loja (ou a mesma mercadoria aparece 2x na nota, ex.: venda + bonificação):
      // usa esse produto em vez de recusar a nota inteira
      const bar = String(it.novo.bar || '').trim(), kf = nota.cnpj && it.cProd ? nota.cnpj + ':' + it.cProd : '';
      const ja = (bar && db.prepare("select id from products where json_extract(data,'$.bar')=?").get(bar)) || (kf && criados[kf] && { id: criados[kf] });
      if (ja) { pid = ja.id; log('entrada: "' + (it.xProd || '') + '" ligado ao produto que já tem o código', bar || kf) }
      else { pid = salvarProdutoTx({ ...it.novo, est: 0 }).id; if (kf) criados[kf] = pid }
    }
    const p = one('products', pid).data, fator = +it.fator > 0 ? +it.fator : 1, custo = r2((+it.vUn || 0) / fator), patch = {};
    if (nota.cnpj && it.cProd) patch.forn = { ...(p.forn || {}), [nota.cnpj + ':' + it.cProd]: fator };
    if (it.ncm && !p.ncm) patch.ncm = it.ncm;
    if (it.ean && !p.bar && /^\d{8,14}$/.test(it.ean) && !db.prepare("select 1 from products where json_extract(data,'$.bar')=?").get(it.ean)) patch.bar = it.ean;
    if (it.preco != null && it.preco !== '' && r2(it.preco) != r2(p.p)) patch.p = r2(it.preco);
    if (it.mk != null && it.mk !== '' && +it.mk != +p.mk) patch.mk = +it.mk;
    if (Object.keys(patch).length) salvarProdutoTx({ id: pid, ...patch }, true);
    const mv = movEstoqueTx({ pid, tipo: 'entrada', q: r3((+it.q || 0) * fator), custo, doc, chave: nota.chave || '' }, ctx, now);
    if (/^\d{4}-\d{2}-\d{2}$/.test(it.val || '')) saveLote({ pid, n: p.n, q: mv.q, val: it.val, doc, chave: nota.chave || '', op: ctx.op.n });
    return mv;
  }));
  if (nota.chave && /<infNFe/.test(String(b.xml || '')) && String(b.xml).length < 3e6) { try { db.prepare("insert or ignore into nfe_dest(chave,emit,nome,valor,dh,st,xml,updated_at) values(?,?,?,?,?,'completa',?,?)").run(nota.chave, digits(nota.cnpj), nota.fornecedor || '', r2(b.total || 0), nota.data || '', String(b.xml).replace(/^\uFEFF/, ''), nowIso()) } catch (e) { } }
  const ps = (b.contas || []).filter(c => /^\d{4}-\d{2}-\d{2}$/.test(c.venc || '') && +c.valor > 0);
  ps.forEach((c, i) => saveConta({ forn: nota.fornecedor || '', cnpj: nota.cnpj || '', doc: 'NF ' + (nota.numero || '') + (ps.length > 1 ? ` · parcela ${i + 1}/${ps.length}` : ''), cat: 'Fornecedor', venc: c.venc, valor: r2(c.valor), chave: nota.chave || '', origem: 'nfe', op: ctx.op.n }));
  log('entrada de nota', doc, r.length, 'itens'); soon(); return r;
}
function movs(q) {
  const pid = q.get('pid'), dias = +q.get('dias') || 30, t0 = Date.now() - dias * 864e5;
  const mv = (pid ? rows('mov_estoque', "where json_extract(data,'$.pid')=?", pid) : rows('mov_estoque')).filter(m => Date.parse(m.date) >= t0);
  let vendas = [];
  if (pid) vendas = rows('orders', "where data like ?", '%' + pid + '%').filter(o => o.fat && Date.parse(o.fat.date) >= t0).map(o => ({ id: o.id, date: o.fat.date, tipo: o.st == 'canc' ? 'venda cancelada' : 'venda', q: -(o.items || []).filter(i => i.pid == pid).reduce((s, i) => s + (+i.q || 0), 0), doc: (o.canal == 'balcao' ? 'Venda #' : 'Pedido #') + o.id.slice(-4).toUpperCase(), op: o.fat.op || '' }));
  return mv.concat(vendas).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/* ---------- contas a pagar ---------- */
const hojeLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const CATS = ['Fornecedor', 'Luz', 'Água', 'Aluguel', 'Internet/telefone', 'Salários', 'Impostos', 'Manutenção', 'Outros'];
function saveConta(c) {
  const id = c.id || crypto.randomUUID(), old = (one('contas', id) || {}).data || {};
  const d = { ...old, ...c, id, criado: old.criado || nowIso() };
  saveRow('contas', d); outbox('merge', id, { tab: 'contas', id, data: d }); return d;
}
function salvarConta(b) {
  const ctx = gerente(b, 'lançar conta a pagar'), c = b.c || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.venc || '')) throw new Error('Informe o vencimento.');
  if (!(+c.valor > 0)) throw new Error('Informe o valor.');
  const d = saveConta({ id: c.id || undefined, forn: String(c.forn || '').trim().slice(0, 80), doc: String(c.doc || '').trim().slice(0, 80), cat: CATS.includes(c.cat) ? c.cat : 'Outros', venc: c.venc, valor: r2(c.valor), obs: String(c.obs || '').slice(0, 200), ...(c.id ? {} : { origem: 'manual', op: ctx.op.n }) });
  log('conta a pagar salva', d.forn, d.valor, d.venc); soon(); return d;
}
function pagarConta(b) {
  const ctx = gerente(b, 'dar baixa em conta'), cur = one('contas', b.id); if (!cur) throw new Error('Conta não encontrada.');
  const c = cur.data;
  if (b.desfazer) { const d = saveConta({ ...c, pago: null }); soon(); return d }
  const pago = { data: /^\d{4}-\d{2}-\d{2}$/.test(b.data || '') ? b.data : hojeLocal(), valor: r2(+b.valor > 0 ? b.valor : c.valor), forma: String(b.forma || 'Outro').slice(0, 40), por: ctx.op.n };
  const d = saveConta({ ...c, pago });
  if (pago.forma == 'Dinheiro do caixa') movimento({ tipo: 'despesa', valor: pago.valor, desc: ('Pagto ' + (c.forn || '') + ' ' + (c.doc || '')).trim() });
  log('conta paga', c.forn, pago.valor, pago.forma); soon(); return d;
}
function excluirConta(b) { gerente(b, 'excluir conta'); const cur = one('contas', b.id); if (!cur) throw new Error('Conta não encontrada.'); const d = saveConta({ ...cur.data, del: true }); soon(); return d }
const contas = () => rows('contas').filter(c => !c.del).sort((a, b) => String(a.venc).localeCompare(String(b.venc)));
function resumoContas() {
  const h = hojeLocal(), em7 = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), ab = contas().filter(c => !c.pago);
  const soma = l => r2(l.reduce((s, c) => s + (+c.valor || 0), 0));
  const venc = ab.filter(c => c.venc < h), hoje = ab.filter(c => c.venc == h), sem = ab.filter(c => c.venc > h && c.venc <= em7);
  return { vencidas: { n: venc.length, v: soma(venc) }, hoje: { n: hoje.length, v: soma(hoje) }, semana: { n: sem.length, v: soma(sem) }, aberto: { n: ab.length, v: soma(ab) } };
}
/* ---------- validade (lotes) ---------- */
function saveLote(l) {
  const id = l.id || crypto.randomUUID(), old = (one('lotes', id) || {}).data || {};
  const d = { ...old, ...l, id, date: old.date || nowIso(), st: l.st || old.st || 'ativo' };
  saveRow('lotes', d); outbox('merge', id, { tab: 'lotes', id, data: d }); return d;
}
function lotes() {
  const h = hojeLocal();
  return rows('lotes').filter(l => l.st == 'ativo').map(l => { const p = (one('products', l.pid) || {}).data || {}; return { ...l, n: p.n || l.n, est: stk(p), dias: Math.round((Date.parse(l.val) - Date.parse(h)) / 864e5) } }).sort((a, b) => String(a.val).localeCompare(String(b.val)));
}
function novoLote(b) {
  const ctx = gerente(b, 'lançar validade'), l = b.l || {}, p = (one('products', l.pid) || {}).data; if (!p) throw new Error('Escolha o produto.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.val || '')) throw new Error('Informe a data de validade.');
  const d = saveLote({ pid: p.id, n: p.n, q: r3(+l.q || 0) || null, val: l.val, doc: String(l.doc || 'Lançado à mão').slice(0, 80), op: ctx.op.n }); soon(); return d;
}
function resolverLote(b) {
  const ctx = gerente(b, 'baixar validade'), cur = one('lotes', b.id); if (!cur) throw new Error('Lote não encontrado.');
  const l = cur.data, q = r3(+b.q || 0);
  const d = tx(() => {
    if (b.como == 'perda') { if (!(q > 0)) throw new Error('Informe quantas unidades vão para perda.'); movEstoqueTx({ pid: l.pid, tipo: 'perda', q, doc: 'Validade ' + l.val, obs: 'Vencido / perto de vencer' }, ctx, nowIso()) }
    return saveLote({ ...l, st: 'resolvido', res: { como: b.como == 'perda' ? 'perda' : 'vendido', q: q || null, data: nowIso(), por: ctx.op.n } });
  });
  soon(); return d;
}
/* ---------- NF-e 55: notas de compra para devolução ---------- */
const tg = (x, t) => { const m = x && x.match(new RegExp(`<(?:\\w+:)?${t}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${t}>`)); return m ? m[1] : '' };
const unx = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
function comprasDev() {
  return db.prepare("select chave,nome,emit,valor,dh from nfe_dest where xml is not null and st<>'cancelada' order by dh desc limit 300").all().map(r => ({ ...r, num: +r.chave.slice(25, 34) }));
}
function compraDev(chave) {
  const r = db.prepare('select xml from nfe_dest where chave=?').get(String(chave || '')); if (!r || !r.xml) throw new Error('XML da nota de compra não encontrado.');
  const x = r.xml, em = tg(x, 'emit'), ee = tg(em, 'enderEmit'), cnpj = tg(em, 'CNPJ');
  const ps = rows('products');
  const itens = [...x.matchAll(/<det nItem="\d+">([\s\S]*?)<\/det>/g)].map(([, d]) => {
    const p = tg(d, 'prod'), im = tg(d, 'ICMS'), cProd = unx(tg(p, 'cProd')), ean = [tg(p, 'cEAN'), tg(p, 'cEANTrib')].find(v => /^\d{8,14}$/.test(v)) || '';
    const prod = ps.find(q => q.forn && q.forn[cnpj + ':' + cProd]) || (ean ? ps.find(q => q.bar == ean) : null);
    const cst = tg(im, 'CST'), csosn = tg(im, 'CSOSN');
    return { cProd, xProd: unx(tg(p, 'xProd')), ncm: tg(p, 'NCM'), cest: tg(p, 'CEST'), ean, u: tg(p, 'uCom'), q: +tg(p, 'qCom'), vUn: +tg(p, 'vUnCom'), orig: +tg(im, 'orig') || 0, csosn: ['10', '30', '60', '70'].includes(cst) || ['201', '202', '203', '500'].includes(csosn) ? '500' : '102', pid: prod ? prod.id : '', pn: prod ? prod.n : '', fator: prod && prod.forn ? +prod.forn[cnpj + ':' + cProd] || 1 : 1 };
  });
  return { chave, num: +tg(tg(x, 'ide'), 'nNF'), data: tg(tg(x, 'ide'), 'dhEmi'), dest: { doc: cnpj || tg(em, 'CPF'), nome: unx(tg(em, 'xNome')), ie: tg(em, 'IE'), indIEDest: tg(em, 'IE') ? 1 : 9, xLgr: unx(tg(ee, 'xLgr')), nro: unx(tg(ee, 'nro')), xCpl: unx(tg(ee, 'xCpl')), xBairro: unx(tg(ee, 'xBairro')), cMun: tg(ee, 'cMun'), xMun: unx(tg(ee, 'xMun')), uf: tg(ee, 'UF'), cep: tg(ee, 'CEP'), fone: tg(ee, 'fone') }, itens };
}
/* emite a NF-e 55 e, se pedido, mexe no estoque (venda = saída; devolução ao fornecedor = saída) */
async function emitirNfe55(b) {
  const ctx = gerente(b, 'emitir NF-e'), doc = b.doc || {};
  const r = await FISCAL.emitir55(doc, ctx);
  if (r && r.st == 'autorizada' && doc.estoque) {
    const movs = tx(() => (doc.itens || []).filter(i => i.pid && +i.qUn > 0 && one('products', i.pid)).map(i => movEstoqueTx({ pid: i.pid, tipo: doc.tipo == 'devolucao' ? 'devforn' : 'saida', q: r3(+i.qUn), doc: 'NF-e ' + r.num + (doc.tipo == 'devolucao' ? ' (devolução)' : ''), chave: r.chave }, ctx, nowIso()).id));
    FISCAL.marca55(r.chave, { estoque: true, movs }); soon();
  }
  return r;
}
async function cancelarNfe55(b) {
  const ctx = gerente(b, 'cancelar NF-e'), r0 = FISCAL.reg55(String(b.chave || ''));
  const r = await FISCAL.cancelar55(String(b.chave || ''), b.just);
  if (r0 && r0.data && r0.data.estoque && !r0.data.estDevolvido) {
    tx(() => (r0.data.doc.itens || []).filter(i => i.pid && +i.qUn > 0 && one('products', i.pid)).forEach(i => movEstoqueTx({ pid: i.pid, tipo: 'ajuste', q: r3(+i.qUn), doc: 'NF-e ' + r0.num + ' cancelada', chave: r0.chave }, ctx, nowIso())));
    FISCAL.marca55(r0.chave, { estDevolvido: true }); soon();
  }
  return r;
}

/* ---------- preço automático (lucro % sobre o custo) ---------- */
const PREC0 = { pct: 30, arred: '90' };
const prec = () => ({ ...PREC0, ...(kvGet('preco') || {}) });

/* ---------- cancelar venda (estorno) ---------- */
function estornar(b) {
  const ctx = ctxRegra(b, 'cancVenda', 'cancelar venda'), motivo = String(b.motivo || '').trim();
  if (!motivo) throw new Error('Informe o motivo do cancelamento.');
  const r = tx(() => {
    const cur = one('orders', b.id); if (!cur) throw new Error('Venda não encontrada.');
    const o = cur.data; if (!o.fat) throw new Error('Só dá para cancelar venda já faturada.'); if (o.st == 'canc') return o;
    const deltas = {};
    if (!o.rest) (o.items || []).forEach(i => { if (i.pid) deltas[i.pid] = r3((deltas[i.pid] || 0) - (+i.q || 0)) });
    for (const [pid, d] of Object.entries(deltas)) { const pc = one('products', pid); if (!pc) continue; const p = pc.data, s = stk(p); if (s === null) continue; p.est = Math.max(0, r3(s - d)); setData('products', pid, p) }
    const canc = { id: crypto.randomUUID(), date: nowIso(), por: ctx.op.n, aut: ctx.aut && ctx.aut != ctx.op.n ? ctx.aut : '', motivo: motivo.slice(0, 200) };
    const novo = { ...o, st: 'canc', done: false, rest: true, canc };
    saveRow('orders', novo); outbox('estornar', o.id, { id: o.id, canc, deltas });
    if (o.fiado && o.fiado.valor > 0) { const fe = { id: crypto.randomUUID(), date: canc.date, cid: o.fiado.cid, cn: o.fiado.cn, tipo: 'estorno', valor: -r2(o.fiado.valor), venda: o.id, op: ctx.op.n, obs: 'Venda cancelada: ' + canc.motivo }; saveRow('fiado', fe); outbox('merge', fe.id, { tab: 'fiado', id: fe.id, data: fe }) }
    return novo;
  });
  log('VENDA CANCELADA', b.id.slice(-6), 'por', ctx.op.n, 'motivo:', motivo); soon(); try { mpEstornar(r) } catch (e) { } return r;
}

/* ---------- pedidos do app (catálogo) ---------- */
function pedidos(q) {
  const dias = +q.get('dias') || 10, t0 = Date.now() - dias * 864e5;
  return rows('orders').filter(o => o.canal != 'balcao' && Date.parse(o.date) >= t0).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}
/* excluir pedido cancelado: o estoque já voltou no cancelamento; pedido faturado não se apaga (é venda) */
function excluirPedidos(b) {
  const op = opSess(b), ids = (Array.isArray(b.ids) ? b.ids : [b.id]).filter(Boolean).slice(0, 500);
  let n = 0;
  tx(() => {
    for (const id of ids) {
      const cur = one('orders', id); if (!cur) continue; const o = cur.data;
      if (o.st != 'canc' || !o.rest) throw new Error('Só dá para excluir pedido cancelado.');
      if (o.fat) throw new Error('O pedido #' + id.slice(-4).toUpperCase() + ' foi faturado: ele fica no histórico de vendas do caixa.');
      db.prepare('delete from orders where id=?').run(id);
      db.prepare("delete from outbox where ref=? and kind in ('status','estornar') and err is not null").run(id);
      outbox('delped', id, { id }); n++;
    }
  });
  if (n) { log('pedidos cancelados excluídos:', n, 'por', op.n); soon() }
  return { excluidos: n };
}
function pedidoStatus(b) {
  const st = b.st; if (!['conf', 'ent', 'canc', 'novo'].includes(st)) throw new Error('Situação inválida.');
  const cur = one('orders', b.id); if (!cur) throw new Error('Pedido não encontrado.');
  const o = cur.data;
  if (st == 'canc' && o.fat) return estornar({ ...b, motivo: b.motivo || 'Pedido cancelado' });
  const ctx = st == 'canc' ? ctxRegra(b, 'cancVenda', 'cancelar pedido') : { op: opSess(b), aut: '' };
  if (o.st == 'canc') throw new Error('Pedido cancelado não pode ser reaberto. Peça para o cliente fazer um novo.');
  if (o.st == 'pagar' && st != 'canc') throw new Error('Este pedido ainda está aguardando o pagamento online do cliente.');
  const r = tx(() => {
    const deltas = {};
    if (st == 'canc' && !o.rest) {
      (o.items || []).forEach(i => { if (i.pid) deltas[i.pid] = r3((deltas[i.pid] || 0) - (+i.q || 0)) });
      for (const [pid, d] of Object.entries(deltas)) { const pc = one('products', pid); if (!pc) continue; const p = pc.data, s = stk(p); if (s === null) continue; p.est = Math.max(0, r3(s - d)); setData('products', pid, p) }
    }
    const novo = { ...o, st, done: st == 'ent', ...(st == 'canc' ? { rest: true, canc: { id: crypto.randomUUID(), date: nowIso(), por: ctx.op.n, aut: ctx.aut && ctx.aut != ctx.op.n ? ctx.aut : '', motivo: String(b.motivo || 'Pedido cancelado').slice(0, 200) } } : {}), hist: [...(o.hist || []), { st, date: nowIso(), por: ctx.op.n }] };
    saveRow('orders', novo);
    if (st == 'canc') outbox('estornar', o.id, { id: o.id, canc: novo.canc, deltas });
    else outbox('status', o.id, { id: o.id, st });
    return novo;
  });
  log('pedido', o.id.slice(-6), '→', st, 'por', ctx.op.n); soon(); if (st == 'canc') try { mpEstornar(r) } catch (e) { } return r;
}
/* ---------- ajustes da loja (config "empresa") ---------- */
/* ---------- PARCEIROS (cadastro fica no banco online; aqui guardamos a lista para o cadastro de produto funcionar sem internet) ---------- */
async function parceiros() {
  try { const l = await rpcOnline('listar_parceiros', {}); kvSet('parceiros', l.map(x => ({ id: x.id, nome: x.nome, entrega: x.entrega, comissao: x.comissao }))); return { online: true, lista: l } }
  catch (e) { return { online: false, erro: e.message, lista: kvGet('parceiros') || [] } }
}
function parteMarcar(b) {   // a loja marca a parte do parceiro pelo caixa (quando o parceiro não usa a tela dele)
  const ctx = opSess(b), cur = one('orders', String(b.id || '')); if (!cur) throw new Error('Pedido não encontrado.');
  const d = cur.data, k = String(b.parc || ''); if (!d.parts || !d.parts[k]) throw new Error('Este pedido não tem produtos desse parceiro.');
  const patch = {}; if (b.st) { if (!['aceito', 'pronto', 'saiu', 'entregue', 'falta'].includes(b.st)) throw new Error('Situação inválida.'); patch.st = b.st; patch[b.st] = nowIso(); patch.porLoja = ctx.op.n }
  if (b.nota != null) patch.nota = String(b.nota).trim().slice(0, 60); if (b.col) patch.col = { por: ctx.op.n + ' (loja)', date: nowIso() };
  d.parts[k] = { ...d.parts[k], ...patch };
  tx(() => { saveRow('orders', d); outbox('parte', d.id, { id: d.id, parc: k, patch }) }); soon(); return d;
}
async function rpcOnline(f, body) {
  if (!S) throw new Error('Entre com a conta da loja primeiro.');
  try { return await api('/rest/v1/rpc/' + f, { method: 'POST', body }) }
  catch (e) {
    if (e instanceof NetErr) throw new Error('Precisa de internet para isso.');
    if (e.status == 404) throw new Error('Rode de novo o supabase.sql no Supabase (faltam as funções dos entregadores).');
    throw e;
  }
}
/* horário de atendimento do app (o banco online confere de novo na função loja_aberta) */
const FUSOS = ['America/Sao_Paulo', 'America/Belem', 'America/Manaus', 'America/Rio_Branco', 'America/Noronha'];
function horLimpo(h) {
  h = h || {}; const ok = t => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || '')), d = {};
  for (let k = 0; k < 7; k++) d[k] = (Array.isArray(h.d && h.d[k]) ? h.d[k] : []).filter(i => Array.isArray(i) && ok(i[0]) && ok(i[1]) && i[0] != i[1]).slice(0, 3).map(i => [i[0], i[1]]);
  return { on: !!h.on, tz: FUSOS.includes(h.tz) ? h.tz : 'America/Sao_Paulo', antes: Math.max(0, Math.min(120, parseInt(h.antes) || 0)), pausa: !!h.pausa, msgPausa: String(h.msgPausa || '').slice(0, 120), d };
}
/* pausar/retomar os pedidos do app direto do PDV (qualquer operador) */
function pausarPedidos(b) {
  const op = opSess(b), cur = one('config', 'empresa'), old = (cur && cur.data) || {};
  const hor = horLimpo({ ...(old.hor || {}), pausa: !!b.pausa, msgPausa: b.msg != null ? b.msg : (old.hor || {}).msgPausa });
  tx(() => { saveRow('config', { id: 'empresa', ...old, hor }); outbox('merge', 'empresa', { tab: 'config', id: 'empresa', data: { hor } }) });
  log('pedidos do app', hor.pausa ? 'PAUSADOS' : 'retomados', 'por', op.n); soon(); return { hor };
}
function salvarConfig(b) {
  const ctx = gerente(b, 'mudar os ajustes da loja'), e = b.emp || {}, cur = one('config', 'empresa'), old = (cur && cur.data) || {};
  const campos = {};
  if ('site' in e) { const u = String(e.site || '').trim(); if (u && !/^https:\/\/[^\s]+$/.test(u)) throw new Error('Endereço do site inválido (comece com https://).'); campos.site = u.replace(/\/(index\.html)?$/, '/').slice(0, 200) }
  for (const k of ['n', 'cnpj', 'e', 'c', 'tel', 'msg', 'pix', 'pixT']) if (k in e) campos[k] = String(e[k] ?? '').slice(0, 300);
  if (!campos.n && !old.n) throw new Error('Informe o nome da loja.');
  if ('taxas' in e) campos.taxas = (Array.isArray(e.taxas) ? e.taxas : []).filter(t => String(t.b || '').trim()).map(t => ({ b: String(t.b).trim().slice(0, 60), v: Math.max(0, r2(t.v)) }));
  if ('tema' in e) campos.tema = /^[a-z]{0,20}$/.test(String(e.tema || '')) ? String(e.tema || '') : '';
  if ('taxaPad' in e) campos.taxaPad = e.taxaPad === '' || e.taxaPad == null ? '' : Math.max(0, r2(e.taxaPad));
  if ('hor' in e) campos.hor = horLimpo(e.hor);
  if ('logo' in e) { const l = String(e.logo || ''); if (l && (!/^data:image\//.test(l) || l.length > 600000)) throw new Error('Logotipo inválido ou grande demais.'); campos.logo = l }
  const data = { ...old, ...campos };
  tx(() => { saveRow('config', { id: 'empresa', ...data }); outbox('merge', 'empresa', { tab: 'config', id: 'empresa', data: campos }) });
  log('ajustes da loja salvos por', ctx.op.n); soon(); return data;
}
function excluirProduto(b) {
  const ctx = gerente(b, 'excluir produto'), cur = one('products', b.id); if (!cur) throw new Error('Produto não encontrado.');
  tx(() => { db.prepare('delete from products where id=?').run(b.id); setFoto(b.id, ''); outbox('del', b.id, { tab: 'products', id: b.id }) });
  log('produto excluído', cur.data.n, 'por', ctx.op.n); soon(); return { ok: true };
}
function importarProdutos(b) {
  const ctx = gerente(b, 'importar produtos'), itens = (b.itens || []).slice(0, 20000);
  if (!itens.length) throw new Error('Nenhum produto na planilha.');
  let novos = 0, alt = 0;
  tx(() => {
    const byCod = db.prepare("select id from products where json_extract(data,'$.cod')=? limit 1"), byBar = db.prepare("select id from products where json_extract(data,'$.bar')=? limit 1");
    for (const it of itens) {
      if (!String(it.n || '').trim() || !(+it.p >= 0)) continue;
      const ex = (it.cod && byCod.get(String(it.cod).trim())) || (it.bar && byBar.get(String(it.bar).trim()));
      const p = { n: it.n, p: it.p, ...(it.c != null ? { c: it.c } : {}), ...(it.marca ? { marca: it.marca } : {}), ...(it.u ? { u: it.u } : {}), ...(it.cod ? { cod: it.cod } : {}), ...(it.bar ? { bar: it.bar } : {}), ...(it.ncm ? { ncm: it.ncm } : {}), ...(it.custo != null && it.custo !== '' ? { custo: it.custo } : {}) };
      if (ex) { salvarProdutoTx({ id: ex.id, ...p }, true); alt++ }
      else { salvarProdutoTx({ ...p, ...(it.est != null && it.est !== '' ? { est: it.est } : {}) }); novos++ }
    }
  });
  log('planilha importada por', ctx.op.n, novos, 'novos', alt, 'alterados'); soon(); return { novos, alt };
}

/* ---------- clientes e fiado ---------- */
const saldoFiado = cid => r2(rows('fiado', "where json_extract(data,'$.cid')=?", cid).reduce((s, f) => s + (+f.valor || 0), 0));
function salvarCliente(b) {
  const op = opSess(b), c = b.c || {}, id = c.id || crypto.randomUUID(), cur = one('clients', id), old = (cur && cur.data) || {};
  const n = String(c.n || '').trim(); if (!n) throw new Error('Informe o nome do cliente.');
  const lim = c.limite === '' || c.limite == null ? (old.limite ?? null) : r2(c.limite);
  let aut = '';
  if ((+lim || 0) != (+old.limite || 0)) aut = gerente(b, 'alterar o limite de fiado').aut;
  const cp = digits(c.cpf);
  const campos = { n, t: String(c.t || '').trim(), cpf: cp, a: String(c.a || '').trim(), limite: lim };
  if (!old.id) Object.assign(campos, { id, date: nowIso(), origem: 'pdv' });
  const data = { ...old, ...campos };
  tx(() => { saveRow('clients', data); outbox('merge', id, { tab: 'clients', id, data: campos }) });
  log('cliente salvo', n, 'por', op.n, aut ? '(limite aut. ' + aut + ')' : ''); soon();
  return { ...data, saldo: saldoFiado(id) };
}
function lancFiado(b, tipo) {
  const ctx = tipo == 'ajuste' ? gerente(b, 'ajustar fiado') : { op: opSess(b), aut: '' };
  const c = one('clients', b.cid); if (!c) throw new Error('Cliente não encontrado.');
  let v = r2(b.valor); if (!v || (tipo == 'pagamento' && v <= 0)) throw new Error('Informe o valor.');
  const formas = ['Dinheiro', 'Pix', 'Débito', 'Crédito'];
  const fe = { id: crypto.randomUUID(), date: nowIso(), cid: b.cid, cn: c.data.n, tipo, valor: tipo == 'pagamento' ? -v : v, ...(tipo == 'pagamento' ? { forma: formas.includes(b.forma) ? b.forma : 'Dinheiro' } : {}), op: ctx.op.n, aut: ctx.aut && ctx.aut != ctx.op.n ? ctx.aut : '', obs: String(b.obs || '').slice(0, 200) };
  tx(() => { saveRow('fiado', fe); outbox('merge', fe.id, { tab: 'fiado', id: fe.id, data: fe }) });
  log('fiado', tipo, c.data.n, v); soon();
  return { ...fe, saldo: saldoFiado(b.cid) };
}
function saldos() {
  const m = {};
  rows('fiado').forEach(f => { const x = m[f.cid] = m[f.cid] || { cid: f.cid, cn: f.cn, saldo: 0, ult: '' }; x.saldo = r2(x.saldo + (+f.valor || 0)); if (f.date > x.ult) x.ult = f.date });
  rows('clients').forEach(c => { if (m[c.id]) Object.assign(m[c.id], { cn: c.n, t: c.t, limite: c.limite ?? null }); else if (+c.limite > 0) m[c.id] = { cid: c.id, cn: c.n, t: c.t, limite: c.limite, saldo: 0, ult: '' } });
  return Object.values(m).sort((a, b) => b.saldo - a.saldo || String(a.cn).localeCompare(String(b.cn), 'pt-BR'));
}

/* ---------- impressão direta (ESC/POS) ---------- */
const prnCfg = () => Object.assign({ mode: 'browser', name: '', cols: 48, ascii: true, drawer: false }, kvGet('prn') || {});
const { escpos, sendRaw, printers } = require('./impressao')({ DATA, log, J });

/* ---------- backup: diário automático, manual, cópia para outra pasta (pendrive, Google Drive, OneDrive) e restaurar ---------- */
const BKDIR = path.join(DATA, 'backup');
const bkCfg = () => kvGet('backupCfg') || {};
const dataNome = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function bkLista(dir, origem) {
  try { return fs.readdirSync(dir).filter(x => /^(pdv-|antes-de-restaurar-).*\.db$/.test(x)).map(f => { const s = fs.statSync(path.join(dir, f)); return { f, origem, tam: s.size, data: s.mtime.toISOString() } }) } catch (e) { return [] }
}
function bkCopiarXml(de, para) {   // cópia incremental dos XMLs (guardar 5 anos)
  let n = 0; if (!fs.existsSync(de)) return 0; fs.mkdirSync(para, { recursive: true });
  for (const x of fs.readdirSync(de, { withFileTypes: true })) {
    const a = path.join(de, x.name), b = path.join(para, x.name);
    if (x.isDirectory()) n += bkCopiarXml(a, b); else if (!fs.existsSync(b)) { fs.copyFileSync(a, b); n++ }
  }
  return n;
}
function bkCopiar(f) {
  const c = bkCfg(); if (!c.pasta) return null;
  try {
    const alvo = path.join(c.pasta, 'AdaptaSysMercado-backup'); fs.mkdirSync(alvo, { recursive: true });
    const nome = f || bkLista(BKDIR, 'pc').filter(x => x.f.startsWith('pdv-')).sort((a, b) => a.data.localeCompare(b.data)).pop()?.f;
    if (nome) fs.copyFileSync(path.join(BKDIR, nome), path.join(alvo, nome));
    const nx = bkCopiarXml(path.join(DATA, 'xml'), path.join(alvo, 'xml'));
    const l = bkLista(alvo, 'pasta').filter(x => x.f.startsWith('pdv-')).sort((a, b) => a.f.localeCompare(b.f)); l.slice(0, Math.max(0, l.length - 15)).forEach(x => { try { fs.unlinkSync(path.join(alvo, x.f)) } catch (e) { } });
    kvSet('backupCfg', { ...c, ultCopia: nowIso(), erroCopia: '' }); log('backup copiado para', alvo, nome || '', nx ? '· ' + nx + ' XML novos' : '');
    return { ok: true, nome, xml: nx };
  } catch (e) { kvSet('backupCfg', { ...c, erroCopia: e.message, ultErro: nowIso() }); log('cópia do backup falhou:', e.message); return { ok: false, erro: e.message } }
}
function backup(manual) {
  try {
    const d = new Date(), name = 'pdv-' + dataNome(d) + (manual ? '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') : '') + '.db', f = path.join(BKDIR, name);
    let novo = false;
    if (!fs.existsSync(f)) { db.exec(`VACUUM INTO '${f.replace(/'/g, "''")}'`); log('backup criado', name); novo = true }
    const l = bkLista(BKDIR, 'pc').filter(x => x.f.startsWith('pdv-')).sort((a, b) => a.f.localeCompare(b.f));
    l.slice(0, Math.max(0, l.length - 30)).forEach(x => fs.unlinkSync(path.join(BKDIR, x.f)));
    const c = bkCfg(); if (c.pasta && (novo || manual || !c.ultCopia || Date.now() - Date.parse(c.ultCopia) > 20 * 3600e3)) bkCopiar(name);
    return name;
  } catch (e) { log('backup falhou:', e.message); if (manual) throw e }
}
setTimeout(backup, 5000); setInterval(backup, 3 * 3600e3);
function bkEstado() {
  const c = bkCfg(), loc = bkLista(BKDIR, 'pc'), fora = c.pasta ? bkLista(path.join(c.pasta, 'AdaptaSysMercado-backup'), 'pasta') : [];
  let pastaOk = null; if (c.pasta) try { fs.accessSync(c.pasta, fs.constants.W_OK); pastaOk = true } catch (e) { pastaOk = false }
  return { dir: BKDIR, pasta: c.pasta || '', pastaOk, ultCopia: c.ultCopia || '', erroCopia: c.erroCopia || '', itens: [...loc, ...fora].sort((a, b) => b.data.localeCompare(a.data)) };
}
function bkConfig(b) {
  gerente(b, 'configurar o backup'); const p = String(b.pasta || '').trim();
  if (p) {
    if (!path.isAbsolute(p)) throw new Error('Informe a pasta completa, por exemplo E:\\ (pendrive) ou C:\\Users\\Loja\\Google Drive');
    if (!fs.existsSync(p)) throw new Error('Pasta não encontrada neste computador: ' + p + '. Se for pendrive, confira se está conectado.');
    try { const t = path.join(p, '.mo-teste'); fs.writeFileSync(t, 'ok'); fs.unlinkSync(t) } catch (e) { throw new Error('Sem permissão para gravar nessa pasta.') }
  }
  kvSet('backupCfg', { ...bkCfg(), pasta: p, erroCopia: '' }); if (p) bkCopiar(); return bkEstado();
}
function bkArquivo(f, origem) {
  if (!/^(pdv-|antes-de-restaurar-)[\w-]+\.db$/.test(String(f || ''))) throw new Error('Arquivo de backup inválido.');
  const dir = origem == 'pasta' ? path.join(bkCfg().pasta || '', 'AdaptaSysMercado-backup') : BKDIR, a = path.join(dir, f);
  if (!fs.existsSync(a)) throw new Error('Backup não encontrado: ' + f); return a;
}
function bkRestaurar(b) {
  const ctx = gerente(b, 'restaurar um backup'); if (b.confirma !== 'RESTAURAR') throw new Error('Digite RESTAURAR para confirmar.');
  const a = bkArquivo(b.f, b.origem);
  try { const t = new DatabaseSync(a, { readOnly: true }); t.prepare('select count(*) n from products').get(); t.close() } catch (e) { throw new Error('Esse arquivo não é um backup válido do sistema.') }
  backup(true);   // guarda o estado atual antes
  fs.writeFileSync(path.join(DATA, 'restaurar.json'), JSON.stringify({ arquivo: a, por: ctx.op.n, em: nowIso() }));
  log('RESTAURAR BACKUP pedido por', ctx.op.n, '·', b.f); setTimeout(() => { try { db.close() } catch (e) { } process.exit(0) }, 800);
  return { ok: true, reinicia: true };
}
/* ---------- tela Início da Gestão: resumo do dia ---------- */
function inicio() {
  const t0 = hoje0().getTime(), agora = Date.now(), dias = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(t0); d.setDate(d.getDate() - i); dias.push({ ini: d.getTime(), dia: d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' }), v: 0, n: 0 }) }
  const hoje = { v: 0, n: 0, app: 0, balcao: 0 }, ontem = { v: 0, n: 0 }, formas = {};
  for (const o of rows('orders', `where data like '%"fat":%'`)) {
    if (!o.fat || o.st == 'canc' || o.canc) continue; const t = Date.parse(o.fat.date), pv = (o.items || []).filter(i => FISCAL.ehParc(i)).reduce((s, i) => s + (+i.t || (+i.q * +i.p) || 0), 0), v = (+o.total || 0) - pv; if (!(t >= dias[0].ini)) continue;
    if (t >= t0 && pv) hoje.parc = (hoje.parc || 0) + pv;
    for (let k = dias.length - 1; k >= 0; k--) if (t >= dias[k].ini) { dias[k].v += v; dias[k].n++; break }
    if (t >= t0) { hoje.v += v; hoje.n++; hoje[o.canal == 'app' ? 'app' : 'balcao'] += v; for (const g of o.pags || []) formas[g.f] = (formas[g.f] || 0) + (+g.v || 0) }
    else if (t >= t0 - 864e5 && t <= agora - 864e5) { ontem.v += v; ontem.n++ }
  }
  const peds = pend(), fz = FISCAL.estado ? FISCAL.estado() : {};
  return { hoje, ontem, dias: dias.map(({ dia, v, n }) => ({ dia, v: Math.round(v * 100) / 100, n })), formas,
    app: { novos: peds.filter(o => o.st == 'novo' || (!o.st && !o.done)).length, conf: peds.filter(o => o.st == 'conf').length },
    backup: (() => { const l = bkLista(BKDIR, 'pc').sort((a, b) => b.data.localeCompare(a.data)); return { ult: l[0] ? l[0].data : '', pasta: !!bkCfg().pasta, erro: bkCfg().erroCopia || '' } })() };
}


/* ---------- HTTP ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg' };
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)) };
function body(req) {
  const max = /\/api\/(ibpt\/importar|produtos\/importar)/.test(req.url) ? 40e6 : 5e6;   // tabela IBPT de todos os estados chega a ~8 MB
  return new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > max) { no(new Error('Muito grande')); req.destroy() } }); req.on('end', () => ok(b ? J(b) || {} : {})); req.on('error', no) });
}
const okHost = h => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(h || ''));
/* ---------- NFC-e ---------- */
const DEPCAT = require('./public/depcat.js');
const empresa = () => (one('config', 'empresa') || {}).data || {};
const FISCAL = require('./fiscal')({ db, DATA, kvGet, kvSet, log, J, tx, one, sefazUrl: u => CFG.sefazMock ? String(CFG.sefazMock).replace(/\/$/, '') + new URL(u).pathname : u });
setTimeout(() => FISCAL.enviarPendentes().catch(() => { }), 15000);
setInterval(() => FISCAL.enviarPendentes().catch(() => { }), 60000);
/* NF-e recebidas: confere a cada 15 min (a própria rotina respeita a espera de 1 h da SEFAZ) */
setTimeout(() => FISCAL.distBuscar().catch(() => { }), 90e3);
setInterval(() => FISCAL.distBuscar().catch(() => { }), 15 * 60e3);
/* ---------- rede da loja: caixas pareados por código ---------- */
const SERVICO = (() => { try { const u = os.userInfo().username || ''; return /^system$/i.test(u) || /\$$/.test(u) } catch (e) { return false } })();
const hashK = k => crypto.createHash('sha256').update(String(k || '')).digest('hex');
const REDES_EXTRA = String(process.env.PDV_REDES_EXTRA || '').split(',').filter(Boolean);   // só para testes
const privado = ip => /^(::ffff:)?(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(ip) || /^f[cde][0-9a-f]{2}:/i.test(ip) || REDES_EXTRA.some(x => ip.replace(/^::ffff:/, '').startsWith(x));
let termCache = null, termToque = 0;
const terminais = () => termCache || (termCache = kvGet('terminais') || []);
function terminalDe(chave, ip) {
  if (!chave) return null; const h = hashK(chave), t = terminais().find(x => x.h == h && !x.off); if (!t) return null;
  if (Date.now() - termToque > 60e3 || t.ip != ip) { t.ultimo = nowIso(); t.ip = ip; termToque = Date.now(); kvSet('terminais', terminais()) }
  return t;
}
function ipsLocais() { const l = []; for (const a of Object.values(os.networkInterfaces()).flat()) if (a && a.family == 'IPv4' && !a.internal) l.push(a.address); return l }
function codigoPareamento(b) {
  gerente(b, 'parear um caixa da rede'); if (!REDE) throw new Error('A rede da loja está desligada neste servidor. Rode o instalador e escolha "Servidor com caixas na rede".');
  const cod = String(crypto.randomInt(100000, 999999)); kvSet('parear', { cod, exp: Date.now() + 10 * 60e3, tent: 0 }); return { codigo: cod, expira: Date.now() + 10 * 60e3, ips: ipsLocais(), porta: PORT };
}
function parearTerminal(b) {
  const p = kvGet('parear'); if (!p || Date.now() > p.exp) throw new Error('Código vencido. Gere outro na Gestão do servidor (Rede e segurança).');
  if (p.tent >= 5) throw new Error('Muitas tentativas. Gere outro código.');
  if (String(b.codigo || '').replace(/\D/g, '') != p.cod) { kvSet('parear', { ...p, tent: p.tent + 1 }); throw new Error('Código incorreto.') }
  const chave = crypto.randomBytes(32).toString('hex'), nome = String(b.nome || '').trim().slice(0, 30) || 'Caixa ' + (terminais().length + 2);
  const l = terminais(); l.push({ id: crypto.randomUUID(), nome, h: hashK(chave), criado: nowIso(), ultimo: nowIso() }); kvSet('terminais', l); kvDel('parear');
  log('caixa da rede pareado:', nome); const e = (one('config', 'empresa') || {}).data || {};
  return { chave, nome, loja: e.n || '' };
}
/* ---------- primeira configuração: o Supabase DESTA empresa ---------- */
async function configurarSupabase(b) {
  if (!b.__local) throw new Error('Só pode ser feito no próprio computador servidor.');
  if (sbOk() && S) gerente(b, 'trocar o banco online');
  let url = String(b.sbUrl || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1.*$/, '');
  if (/^[a-z0-9]{20}$/i.test(url)) url = 'https://' + url + '.supabase.co';          // colou só o "project ref"
  if (!/^https?:\/\/[^\s/]+$/.test(url)) throw new Error('Endereço inválido. Ex.: https://abcdefghijklmnopqrst.supabase.co');
  const key = String(b.sbKey || '').trim();
  if (!/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(key) && !/^sb_publishable_[\w-]+$/.test(key)) throw new Error('Chave inválida. Use a chave pública "anon" (começa com eyJ) ou "publishable" (sb_publishable_...).');
  if (/"role"\s*:\s*"service_role"/.test(Buffer.from(key.split('.')[1] || '', 'base64').toString())) throw new Error('Essa é a chave SECRETA (service_role). Use a chave pública "anon".');
  let r; try { r = await raw(url + '/auth/v1/settings', { headers: { apikey: key } }, 12000) } catch (e) { throw new Error('Não consegui falar com esse endereço (' + e.message + '). Confira a internet e o endereço.') }
  if (r.status == 401 || r.status == 403) throw new Error('O Supabase recusou a chave. Confira se copiou a chave "anon" do mesmo projeto.');
  if (!r.ok) throw new Error('Esse endereço não respondeu como um Supabase (HTTP ' + r.status + ').');
  const mudou = url != CFG.sbUrl;
  Object.assign(CFG, { sbUrl: url, sbKey: key });
  const f = path.join(DATA, 'config.json'); fs.writeFileSync(f, JSON.stringify({ ...readJson(f), sbUrl: url, sbKey: key }, null, 2));
  if (mudou) { S = null; kvDel('session'); needLogin = true; online = false; db.prepare("delete from kv where k like 'cur\\_%' escape '\\'").run() }
  log('configuração: banco online', url, mudou ? '(novo)' : '(mesmo)');
  return { ok: true, sbUrl: url };
}

/* ---------- conferência dos arquivos do sistema (alguém mexeu?) ---------- */
let INTEG = { ok: true, alterados: [], conferido: null };
function conferirArquivos() {
  try {
    const m = readJson(path.join(ROOT, 'manifest.json')); if (!m.arquivos) { INTEG = { ok: true, semLista: true, conferido: nowIso() }; return }
    const alt = [];
    for (const [rel, h] of Object.entries(m.arquivos)) { const f = path.join(ROOT, rel); let x = null; try { x = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') } catch (e) { } if (x != h) alt.push(rel) }
    INTEG = { ok: !alt.length, alterados: alt.slice(0, 30), versao: m.versao, conferido: nowIso() };
    if (alt.length) log('ATENÇÃO: arquivos do sistema diferentes do original:', alt.join(', '));
  } catch (e) { INTEG = { ok: true, erro: e.message } }
}
setTimeout(conferirArquivos, 3000); setInterval(conferirArquivos, 6 * 3600e3);

/* abre o PDV/Gestão numa janela própria (Chrome/Edge em modo aplicativo), sem barra de endereço */
const NAV_FLAGS = ['--kiosk-printing', '--start-maximized', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate,msEdgeSidebarV2,msHubApps', '--hide-crash-restore-bubble', '--disable-session-crashed-bubble', '--overscroll-history-navigation=0', '--disable-pinch'];
function acharNavegador() {
  const e = process.env, c = [path.join(e.ProgramFiles || '', 'Google\\Chrome\\Application\\chrome.exe'), path.join(e['ProgramFiles(x86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'), path.join(e.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'), path.join(e['ProgramFiles(x86)'] || '', 'Microsoft\\Edge\\Application\\msedge.exe'), path.join(e.ProgramFiles || '', 'Microsoft\\Edge\\Application\\msedge.exe')];
  return c.find(f => { try { return fs.existsSync(f) } catch (x) { return false } });
}
function abrirTela(b) {
  const rel = String(b.tela || 'pdv.html').replace(/^\/+/, '');
  if (!/^(pdv|gestao)\.html([?#][\w=&#.-]*)?$/.test(rel)) throw new Error('Tela inválida.');
  if (process.platform != 'win32' || SERVICO) throw new Error('NAO_WINDOWS');   // como serviço (SYSTEM) não dá para abrir janela na tela do usuário
  const nav = acharNavegador(); if (!nav) throw new Error('NAO_WINDOWS');
  spawn(nav, ['--app=http://localhost:' + PORT + '/' + rel, '--user-data-dir=' + path.join(DATA, 'navegador'), ...NAV_FLAGS], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true };
}
/* ---------- Mercado Pago (o token fica só aqui; o app e o Supabase nunca veem) ---------- */
const MP = require('./mp')({ kvGet, kvSet, log, raw, base: CFG.mpMock });
function gravarEmp(campos) {
  const cur = one('config', 'empresa'), old = (cur && cur.data) || {};
  tx(() => { saveRow('config', { id: 'empresa', ...old, ...campos }); outbox('merge', 'empresa', { tab: 'config', id: 'empresa', data: campos }) }); soon();
}
function mpEstado() {
  const c = MP.cfg();
  return { ok: !!c.token, conta: c.conta || null, pix: !!c.token && c.pix !== false, point: !!c.token && !!c.point && !!c.terminal, app: !!c.token && !!c.app, terminal: c.terminal || '', juros: c.juros || 'loja', via: !!c.via, prazo: c.prazo || 20, fim: c.token ? String(c.token).slice(-6) : '' };
}
async function mpConfig(b) {
  const ctx = gerente(b, 'configurar o Mercado Pago'); let c = { ...MP.cfg() };
  if (b.remover) { MP.salvar({}); gravarEmp({ mpApp: false }); log('Mercado Pago desligado por', ctx.op.n); return mpEstado() }
  const tk = String(b.tokenMp || '').trim();
  if (tk) {
    if (/^(TEST|APP_USR)-[\w-]+$/.test(tk) == false) throw new Error('Cole o Access Token (começa com APP_USR- ou TEST-). A "Public Key" não serve aqui.');
    c.conta = await MP.testar(tk); c.token = tk;
  }
  if (!c.token) throw new Error('Cole o Access Token da sua conta Mercado Pago.');
  for (const k of ['pix', 'point', 'app', 'via']) if (k in b) c[k] = !!b[k];
  if ('terminal' in b) c.terminal = String(b.terminal || '').slice(0, 80);
  if ('juros' in b) c.juros = b.juros == 'cliente' ? 'cliente' : 'loja';
  if ('prazo' in b) c.prazo = Math.max(10, Math.min(60, +b.prazo || 20));
  MP.salvar(c); gravarEmp({ mpApp: !!c.app });
  log('Mercado Pago configurado por', ctx.op.n, c.conta && c.conta.nome ? '· conta ' + c.conta.nome : ''); return mpEstado();
}
/* atualiza o pagamento do pedido aqui e no Supabase (o app do cliente lê de lá) */
function mpGrava(id, mp, st) {
  const cur = one('orders', id); if (!cur) return null; const d = cur.data;
  d.mp = { ...(d.mp || {}), ...mp }; if (st && d.st != 'canc') { d.st = st; d.done = false }
  tx(() => { saveRow('orders', d); outbox('mp', id, { id, mp: d.mp, st: st || null }) }); soon(); return d;
}
function cancelarSistema(o, motivo) {
  tx(() => {
    const deltas = {};
    if (!o.rest) (o.items || []).forEach(i => { if (i.pid) deltas[i.pid] = r3((deltas[i.pid] || 0) - (+i.q || 0)) });
    for (const [pid, d] of Object.entries(deltas)) { const pc = one('products', pid); if (!pc) continue; const p = pc.data, s = stk(p); if (s === null) continue; p.est = Math.max(0, r3(s - d)); setData('products', pid, p) }
    const canc = { id: crypto.randomUUID(), date: nowIso(), por: 'Sistema', aut: '', motivo };
    saveRow('orders', { ...o, st: 'canc', done: false, rest: true, canc }); outbox('estornar', o.id, { id: o.id, canc, deltas });
  });
  log('pedido', o.id.slice(-6), 'cancelado:', motivo); soon();
}
/* devolve o dinheiro de pagamentos feitos pelo Mercado Pago (pedido do app cancelado ou venda cancelada) */
function mpEstornar(o) {
  const alvos = [];
  if (o.mp && o.mp.st == 'pago' && o.mp.pid && (o.mp.gw || o.gw || 'mp') == 'mp') alvos.push({ k: 'pag', id: o.mp.pid, app: true });
  if (o.mp && o.mp.st == 'pago' && (o.mp.gw || o.gw) == 'ip') log('InfinitePay: pedido', o.id.slice(-6), 'pago e cancelado. DEVOLVA R$', o.mp.v, 'pelo app da InfinitePay.');
  for (const g of o.pags || []) if (g.mp && g.mp.id && !g.mp.app && g.mp.k != 'ip') alvos.push({ k: g.mp.k == 'point' ? 'point' : 'pag', id: g.mp.k == 'point' ? g.mp.id : (g.mp.pid || g.mp.id) });
  for (const a of alvos) (a.k == 'point' ? MP.pointEstornar(a.id) : MP.estornarPagamento(a.id))
    .then(() => { log('Mercado Pago: devolvido ao cliente', a.k, a.id, 'pedido', o.id.slice(-6)); if (a.app) mpGrava(o.id, { st: 'estornado' }) })
    .catch(e => log('Mercado Pago: NÃO foi possível devolver', a.id, '-', e.message, '(devolva pelo app do Mercado Pago)'));
}
const mpVez = {};
const IP = require('./ip')({ kvGet, kvSet, raw, base: CFG.ipMock });
function ipEstado() { const c = IP.cfg(); return { ok: !!(c.tag || c.key), tag: c.tag || '', chave: !!c.key, app: !!c.app && !!(c.tag || c.key), site: empresa().site || '' } }
function ipConfig(b) {
  const ctx = gerente(b, 'configurar a InfinitePay'); let c = { ...IP.cfg() };
  if (b.remover) { IP.salvar({}); gravarEmp({ ipApp: false }); log('InfinitePay desligada por', ctx.op.n); return ipEstado() }
  if ('tag' in b) { const t = IP.tagOk(b.tag); if (t && !/^[a-z0-9_.-]{2,40}$/.test(t)) throw new Error('InfiniteTag inválida (ex.: mercadodojoao).'); c.tag = t }
  const k = String(b.chaveIp || '').trim(); if (k) { if (!/^inchk_[\w-]+$/.test(k)) throw new Error('A API Key da InfinitePay começa com inchk_.'); c.key = k }
  if (b.tirarChave) delete c.key;
  if ('app' in b) c.app = !!b.app;
  if (!c.tag && !c.key) throw new Error('Informe a InfiniteTag da loja.');
  IP.salvar(c); gravarEmp({ ipApp: !!c.app });
  log('InfinitePay configurada por', ctx.op.n, '· $' + (c.tag || '?'), c.key ? '(com API Key)' : ''); return ipEstado();
}
/* pagamento pelo app: Mercado Pago (mp) ou InfinitePay (ip), conforme o cliente escolheu */
async function mpApp() {
  const c = MP.cfg(), ci = IP.cfg(); if (!c.token && !ci.tag && !ci.key) return;
  const agora = Date.now();
  for (const o of rows('orders', `where data like '%"Online"%' or data like '%"mp":%'`)) {
    if (o.canal != 'app' || o.fat || Date.parse(o.date) < agora - 3 * 864e5) continue;
    const m = o.mp || {}, gw = m.gw || o.gw || 'mp';
    const espera = o.st == 'pagar' && m.st != 'pago';
    const retNovo = gw == 'ip' && m.ret && m.ret.tnsu && m.ret.tnsu != m.chk && !['pago', 'pago_tarde'].includes(m.st);
    const trocou = o.st != 'pagar' && o.st != 'canc' && (m.id || m.link) && !['pago', 'cancelado', 'estornado', 'expirado'].includes(m.st);
    if (!espera && !trocou && !retNovo) continue;
    if (!retNovo && mpVez[o.id] && agora - mpVez[o.id] < (m.id || m.link ? 5000 : 15000)) continue; mpVez[o.id] = agora;
    try {
      const prazo = c.prazo || 20, cli = (one('clients', o.cid) || {}).data || {}, tit = 'Pedido #' + o.id.slice(-4).toUpperCase() + ' · ' + (empresa().n || 'Loja');
      if (gw == 'ip') {
        if (retNovo) {
          const r = await IP.conferir({ ref: o.id, tnsu: m.ret.tnsu, slug: m.ret.slug });
          if (r.pago && r.v >= +o.total - 0.01) {
            if (o.st == 'canc') { mpGrava(o.id, { st: 'pago_tarde', pid: m.ret.tnsu, tipo: r.tipo, v: r.pagoV, chk: m.ret.tnsu }); log('InfinitePay: ATENÇÃO, o cliente pagou o pedido', o.id.slice(-6), 'depois de cancelado. Devolva pelo app da InfinitePay.') }
            else { mpGrava(o.id, { st: 'pago', pid: m.ret.tnsu, slug: m.ret.slug, tipo: r.tipo, v: +o.total, pagoV: r.pagoV, parcelas: r.parcelas, quando: nowIso(), chk: m.ret.tnsu }, o.st == 'pagar' ? 'novo' : null); log('InfinitePay: pedido', o.id.slice(-6), 'PAGO', r.tipo, 'R$', r.pagoV) }
          } else { mpGrava(o.id, { chk: m.ret.tnsu }); if (r.pago) log('InfinitePay: valor pago menor que o pedido', o.id.slice(-6), r.v) }
          continue;
        }
        if (!espera) { if (trocou) mpGrava(o.id, { st: 'cancelado' }); continue }
        if (!m.link) {
          if (!ci.app) continue;
          const site = empresa().site || '', red = site ? site.replace(/\/?$/, '/') + 'index.html?ipret=1&p=' + encodeURIComponent(o.id) : '';
          const wh = sbOk() ? CFG.sbUrl.replace(/\/$/, '') + '/rest/v1/rpc/ip_webhook?apikey=' + encodeURIComponent(CFG.sbKey) : '';
          const l = await IP.linkCriar({ v: o.total, ref: o.id, titulo: tit, cliente: { nome: cli.n || o.cn, email: cli.email, tel: cli.t || o.ph }, redirect: red, webhook: wh, min: prazo + 5 });
          mpGrava(o.id, { gw: 'ip', st: 'aguardando', link: l.url, exp: new Date(agora + prazo * 60000).toISOString(), v: +o.total });
          log('InfinitePay: link criado para o pedido', o.id.slice(-6), 'R$', o.total); continue;
        }
        if (m.exp && agora > Date.parse(m.exp) + 5 * 60000) { mpGrava(o.id, { st: 'expirado' }); cancelarSistema(one('orders', o.id).data, 'O pagamento online não foi feito a tempo') }
        continue;
      }
      // Mercado Pago
      if (!c.token) continue;
      if (!m.id) {
        if (!c.app) continue;
        const px = await MP.pixCriar({ v: o.total, ref: o.id, desc: tit, email: cli.email, min: prazo });
        let lk = null; try { lk = await MP.linkCriar({ v: o.total, ref: o.id, titulo: tit, min: prazo, email: cli.email }) } catch (e) { log('Mercado Pago: link de cartão não criado:', e.message) }
        mpGrava(o.id, { gw: 'mp', id: px.id, st: 'aguardando', qr: px.qr, qr64: px.qr64, link: lk ? lk.link : '', exp: new Date(agora + prazo * 60000).toISOString(), v: px.v });
        log('Mercado Pago: cobrança criada para o pedido', o.id.slice(-6), 'R$', px.v); continue;
      }
      const ok = (await MP.pagamentosDe(o.id)).find(x => x.st == 'approved');
      if (ok) { mpGrava(o.id, { st: 'pago', pid: ok.id, tipo: ok.tipo, v: ok.v, parcelas: ok.parcelas, quando: ok.quando || nowIso(), qr: '', qr64: '' }, espera ? 'novo' : null); log('Mercado Pago: pedido', o.id.slice(-6), 'PAGO', ok.tipo, 'R$', ok.v); continue }
      if (trocou) { await MP.pixCancelar(m.id); mpGrava(o.id, { st: 'cancelado', qr: '', qr64: '' }); continue }
      if (m.exp && agora > Date.parse(m.exp) + 90000) { await MP.pixCancelar(m.id); mpGrava(o.id, { st: 'expirado', qr: '', qr64: '' }); cancelarSistema(one('orders', o.id).data, 'O pagamento online não foi feito a tempo') }
    } catch (e) { if (!(e instanceof NetErr)) log((gw == 'ip' ? 'InfinitePay' : 'Mercado Pago') + ' (pedido ' + o.id.slice(-6) + '):', e.message) }
  }
}
const ROUTES = {
  'POST /api/abrir': b => abrirTela(b),
  'GET /api/mp': () => mpEstado(),
  'GET /api/inicio': () => inicio(),
  'GET /api/backup': () => bkEstado(),
  'POST /api/backup/agora': b => { gerente(b, 'fazer backup'); const n = backup(true); return { nome: n, copia: bkCfg().pasta ? bkCopiar(n) : null, ...bkEstado() } },
  'POST /api/backup/config': b => bkConfig(b),
  'POST /api/backup/copiar': b => { gerente(b, 'copiar o backup'); const r = bkCopiar(); if (!r) throw new Error('Escolha primeiro a pasta de cópia.'); if (!r.ok) throw new Error('Não consegui copiar: ' + r.erro); return { ...r, ...bkEstado() } },
  'POST /api/backup/restaurar': b => bkRestaurar(b),
  'GET /api/ip': () => ipEstado(),
  'POST /api/ip/config': b => ipConfig(b),
  'POST /api/mp/config': b => mpConfig(b),
  'POST /api/mp/terminais': b => { gerente(b, 'ver as maquininhas'); return MP.terminais() },
  'POST /api/mp/modo-pdv': async b => { gerente(b, 'configurar a maquininha'); await MP.modoPdv(String(b.id || '')); return MP.terminais() },
  'POST /api/mp/pix': b => { const op = opSess(b); return MP.pixCriar({ v: b.v, ref: b.ref, desc: (empresa().n || 'Loja') + ' · caixa ' + (op.n || ''), cpf: b.cpf, min: 15 }) },
  'POST /api/mp/pix/ver': b => { opSess(b); return MP.pagamento(String(b.id || '')) },
  'POST /api/mp/pix/cancelar': b => { opSess(b); return MP.pixCancelar(String(b.id || '')) },
  'POST /api/mp/point': b => { opSess(b); if (!MP.cfg().point) throw new Error('A maquininha está desligada em Gestão > Mercado Pago.'); return MP.pointCriar({ v: b.v, tipo: b.tipo, parcelas: b.parcelas, ref: b.ref, desc: empresa().n || 'Venda' }) },
  'POST /api/mp/point/ver': b => { opSess(b); return MP.pointVer(String(b.id || '')) },
  'POST /api/mp/point/cancelar': b => { opSess(b); return MP.pointCancelar(String(b.id || '')) },
  'GET /api/som/info': () => { const t = kvGet('toque'); return t ? { nome: t.nome, v: t.v, kb: t.kb } : null },
  'POST /api/som': b => {
    const ctx = { op: opSess(b) }, m = /^data:(audio\/(?:mpeg|mp3|ogg|wav|x-wav|mp4|x-m4a|aac|webm));base64,(.+)$/s.exec(String(b.b64 || ''));
    if (!m) throw new Error('Envie um arquivo de áudio (MP3, M4A, OGG ou WAV).');
    const buf = Buffer.from(m[2], 'base64'); if (buf.length > 3e6) throw new Error('Arquivo grande demais (máx. 3 MB). Use um toque curto.');
    if (buf.length < 500) throw new Error('Arquivo de áudio vazio ou inválido.');
    fs.writeFileSync(path.join(DATA, 'toque.bin'), buf);
    const t = { nome: String(b.nome || 'toque').slice(0, 80), mime: m[1] == 'audio/mp3' ? 'audio/mpeg' : m[1], v: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10), kb: Math.round(buf.length / 1024) };
    kvSet('toque', t); log('toque de pedido trocado por', ctx.op.n, t.nome, t.kb + ' KB'); return { nome: t.nome, v: t.v, kb: t.kb };
  },
  'POST /api/som/remover': b => { opSess(b); kvDel('toque'); try { fs.unlinkSync(path.join(DATA, 'toque.bin')) } catch (e) { } return { ok: true } },
  'GET /api/setup': () => ({ configurado: sbOk(), sbUrl: CFG.sbUrl || '', conectado: !!S, loja: ((one('config', 'empresa') || {}).data || {}).n || '' }),
  'POST /api/setup': b => configurarSupabase(b),
  'GET /api/descoberta': () => { const e = (one('config', 'empresa') || {}).data || {}; return { mercadoOnline: true, pdvMezzomo: true, loja: e.n || 'Mercado', nome: os.hostname(), rede: REDE } },
  'POST /api/parear': b => parearTerminal(b),
  'GET /api/rede': () => ({ rede: REDE, servico: SERVICO, ips: ipsLocais(), porta: PORT, maquina: os.hostname(), dados: DATA, integridade: INTEG, terminais: terminais().filter(t => !t.off).map(t => ({ id: t.id, nome: t.nome, criado: t.criado, ultimo: t.ultimo, ip: t.ip })), certProtegido: !!kvGet('certSenhaDp') }),
  'POST /api/rede/codigo': b => codigoPareamento(b),
  'POST /api/rede/remover': b => { gerente(b, 'remover um caixa da rede'); const l = terminais(); const t = l.find(x => x.id == b.id); if (t) { t.off = true; kvSet('terminais', l); log('caixa da rede removido:', t.nome) } return { ok: true } },
  /* reinicia o servidor: ele sai e o vigia (iniciar.vbs) liga de novo em ~3 s */
  'POST /api/reiniciar': b => { let quem = 'este computador'; if (!b.__local || b.token) quem = opSess(b).n; log('REINICIAR pedido por', quem); setTimeout(() => { try { db.close() } catch (e) { } process.exit(0) }, 400); return { ok: true } },
  'GET /api/status': () => status(),
  'POST /api/login': async b => {
    if (!sbOk()) throw new Error('Configure primeiro o banco online (Supabase) desta empresa.');
    if (!b.email || !b.password) throw new Error('Informe e-mail/WhatsApp e senha.');
    let s;
    try { s = await auth('password', { email: b.email, password: b.password }) }
    catch (e) { if (e instanceof NetErr) throw new Error('Sem internet. O primeiro acesso deste computador precisa de internet (só uma vez).'); throw new Error('E-mail/WhatsApp ou senha incorretos.') }
    let adm; try { adm = await api('/rest/v1/rpc/sou_admin', { method: 'POST', body: {}, tk: s.access_token }) }
    catch (e) { if (e.status == 404) throw new Error('O banco online ainda não foi preparado: no Supabase, abra o SQL Editor, cole o arquivo supabase.sql e clique em Run.'); throw e }
    if (!adm) throw new Error('Essa conta não é administradora da loja.');
    const prev = kvGet('owner');
    if (prev && prev != s.user.id) { ['products', 'clients', 'orders', 'caixa', 'config'].forEach(t => kvDel('cur_' + t)) }
    S = s; kvSet('session', S); kvSet('owner', s.user.id); needLogin = false; log('login', s.user.email);
    await syncNow(); return status();
  },
  'POST /api/logout': async () => {
    const n = db.prepare('select count(*) n from outbox where err is null').get().n;
    if (n) throw new Error(`Há ${n} lançamento(s) ainda não enviados. Conecte à internet e espere sincronizar antes de sair.`);
    S = null; kvDel('session'); needLogin = true; online = false; return { ok: true };
  },
  'GET /api/products': () => rows('products'),
  'GET /api/clients': () => rows('clients'),
  'GET /api/config': () => { const r = one('config', 'empresa'); return r ? r.data : null },
  'GET /api/pend': () => pend(),
  'GET /api/dia': () => dia(),
  'GET /api/estrutura': () => limparTax(DEPCAT.estrutura(empresa())),
  'POST /api/estrutura': b => { gerente(b, 'mudar departamentos e categorias'); const t = limparTax(b.tax); gravarTax(t); return t },
  'POST /api/produtos/classificar': b => classificarProdutos(b),
  'GET /api/relatorio/departamentos': (b, q) => relDepartamentos(q),
  'POST /api/faturar': b => faturar(b.id, b.data, { op: opSess(b), aut: autDe(b) }),
  'GET /api/ops': () => ({ ops: opsAtivos().map(opPub), todos: rows('operadores').map(opPub), primeiro: !opsAtivos().length }),
  'POST /api/op/login': b => {
    const o0 = opsAtivos().find(x => x.id == b.id);
    // "Entrar sem senha" (Gestão > Regras): toca no nome e entra
    const semPin = regras().semPin && o0 && (b.pin === undefined || b.pin === null || b.pin === '');
    if (!semPin) pinBloqueado();
    const o = o0;
    if (!o || (!semPin && (!o.hash || hashPin(b.pin, o.salt) != o.hash))) { if (!semPin) pinFalhas.push(Date.now()); throw new Error(o ? 'PIN incorreto.' : 'Operador não encontrado.') }
    const token = crypto.randomBytes(18).toString('hex'); SESS.set(token, { op: opPub(o), t: Date.now() }); log('operador entrou:', o.n);
    return { token, op: opPub(o) };
  },
  'POST /api/op/logout': b => { SESS.delete(b.token); return { ok: true } },
  'POST /api/op/me': b => ({ op: opSess(b) }),
  'POST /api/op/auth': b => {
    const g = regras().semPin && b.id ? opsAtivos().find(x => x.nivel == 'gerente' && x.id == b.id)
      : (pinBloqueado(), opsAtivos().find(x => x.nivel == 'gerente' && x.hash && hashPin(b.pin, x.salt) == x.hash));
    if (!g) { pinFalhas.push(Date.now()); throw new Error('Senha de gerente incorreta.') }
    const auth = crypto.randomBytes(12).toString('hex'); AUTHS.set(auth, { n: g.n, exp: Date.now() + 120000 }); log('autorização do gerente', g.n, '·', b.acao || '');
    return { auth, n: g.n };
  },
  'POST /api/ops/save': b => salvarOperador(b),
  'GET /api/regras': () => regras(),
  'POST /api/regras': b => { gerente(b, 'mudar as regras'); const r = b.regras || {}; const v = { cancItem: !!r.cancItem, cancVenda: !!r.cancVenda, descMax: Math.max(0, Math.min(100, +r.descMax || 0)), precoMenor: !!r.precoMenor, cadProduto: !!r.cadProduto, pinTroca: !!r.pinTroca, semPin: !!r.semPin }; kvSet('regras', v); log('regras salvas', JSON.stringify(v)); return v },
  'POST /api/produto': b => salvarProduto(b),
  'POST /api/produto/excluir': b => excluirProduto(b),
  'POST /api/produtos/importar': b => importarProdutos(b),
  'GET /api/pedidos': (b, q) => pedidos(q),
  'GET /api/contas': () => ({ contas: contas(), resumo: resumoContas(), cats: CATS, hoje: hojeLocal() }),
  'POST /api/conta': b => salvarConta(b),
  'POST /api/conta/pagar': b => pagarConta(b),
  'POST /api/conta/excluir': b => excluirConta(b),
  'GET /api/lotes': () => ({ lotes: lotes(), hoje: hojeLocal() }),
  'POST /api/lote': b => novoLote(b),
  'POST /api/lote/resolver': b => resolverLote(b),
  'GET /api/precificacao': () => prec(),
  'POST /api/precificacao': b => { gerente(b, 'mudar o lucro padrão'); const v = { pct: Math.max(0, Math.min(1000, +b.pct || 0)), arred: ['', '90', '99', '9'].includes(b.arred) ? b.arred : '90' }; kvSet('preco', v); return v },
  'POST /api/pedido/excluir': b => excluirPedidos(b),
  'POST /api/pedido/status': b => pedidoStatus(b),
  'POST /api/config': b => salvarConfig(b),
  'POST /api/pedidos/pausa': b => pausarPedidos(b),
  /* entregadores: ficam no banco online (o celular do entregador acessa por lá) */
  'GET /api/entregadores': () => rpcOnline('listar_entregadores', {}),
  'GET /api/parceiros': () => parceiros(),
  'POST /api/parceiros': async b => { gerente(b, 'cadastrar parceiro'); const r = await rpcOnline('salvar_parceiro', { p: { id: b.id || '', nome: b.nome, cnpj: b.cnpj, endereco: b.endereco, loc: b.loc || null, fone: b.fone, entrega: b.entrega, comissao: b.comissao } }); await parceiros(); return r },
  'POST /api/parceiros/codigo': b => { gerente(b, 'gerar código de parceiro'); return rpcOnline('novo_codigo_parceiro', { p_id: b.id }) },
  'POST /api/parceiros/remover': async b => { gerente(b, 'remover parceiro'); const n = db.prepare("select count(*) n from products where json_extract(data,'$.parc')=?").get(String(b.id || '')).n; if (n && !b.mesmoAssim) throw new Error(n + ' produto(s) estão com o estoque deste parceiro. Mude esses produtos para "Loja" antes, ou confirme de novo.'); await rpcOnline('remover_parceiro', { p_id: b.id }); return parceiros() },
  'POST /api/parceiros/pagar': b => { const ctx = gerente(b, 'registrar repasse a parceiro'); return rpcOnline('pagar_parceiro', { p_id: b.id, p_valor: r2(b.valor), p_obs: String(b.obs || ''), p_por: ctx.op.n }) },
  'GET /api/parceiros/extrato': (b, q) => rpcOnline('extrato_parceiro', { p_id: q.get('id'), p_dias: Math.max(1, Math.min(93, +q.get('dias') || 31)) }),
  'POST /api/pedido/parte': b => parteMarcar(b),
  'POST /api/entregadores': b => { gerente(b, 'cadastrar entregador'); return rpcOnline('criar_entregador', { p_nome: String(b.nome || '') }) },
  'POST /api/entregadores/codigo': b => { gerente(b, 'gerar código de entregador'); return rpcOnline('novo_codigo_entregador', { p_id: b.id }) },
  'POST /api/entregadores/config': b => { gerente(b, 'mudar o valor da entrega'); return rpcOnline('configurar_entregador', { p_id: b.id, p_valor: Math.max(0, r2(b.valor)), p_modo: b.modo == 'taxa' ? 'taxa' : 'fixo' }) },
  'POST /api/entregadores/pagar': b => { const ctx = gerente(b, 'pagar entregador'); return rpcOnline('pagar_entregador', { p_id: b.id, p_valor: r2(b.valor), p_obs: String(b.obs || ''), p_por: ctx.op.n }) },
  'POST /api/entregadores/remover': b => { gerente(b, 'remover entregador'); return rpcOnline('remover_entregador', { p_id: b.id }) },
  'POST /api/estoque': b => estoque(b),
  'POST /api/entrada': b => entrada(b),
  'GET /api/movs': (b, q) => movs(q),
  'POST /api/estornar': async b => {
    const r = estornar(b), nf = FISCAL.daVenda(b.id);
    if (nf && nf.st == 'autorizada') { try { r.nfce = await FISCAL.cancelar(nf.chave, 'Venda cancelada no caixa: ' + String(b.motivo || '').trim()) } catch (e) { r.nfceErro = e.message } }
    else if (nf && nf.st == 'contingencia') r.nfceErro = 'A NFC-e desta venda ainda está em contingência. Depois que ela for enviada, cancele em Gestão > Fiscal.';
    return r;
  },
  'GET /api/fiscal': () => FISCAL.cfgPublic(),
  'POST /api/fiscal': b => { gerente(b, 'alterar os dados fiscais'); return FISCAL.salvarCfg(b.cfg || {}) },
  'POST /api/fiscal/cert': b => { gerente(b, 'instalar o certificado digital'); return FISCAL.salvarCert(b) },
  'POST /api/fiscal/status': () => FISCAL.statusServico(),
  'POST /api/nfce/emitir': b => { opSess(b); return FISCAL.emitir(String(b.venda || '')) },
  'POST /api/nfce/enviar': async () => ({ enviadas: await FISCAL.enviarPendentes(), ...FISCAL.estado() }),
  'POST /api/nfce/cancelar': b => { gerente(b, 'cancelar NFC-e'); return FISCAL.cancelar(String(b.chave || ''), b.just) },
  'POST /api/nfce/danfe': b => FISCAL.danfe(String(b.chave || ''), { msg: b.msg }),
  'GET /api/dfe/lista': (b, q) => ({ estado: FISCAL.distEstado(), notas: FISCAL.distLista({ dias: q.get('dias') }) }),
  'POST /api/dfe/buscar': async b => { gerente(b, 'buscar notas na SEFAZ'); return { ...(await FISCAL.distBuscar(true)), estado: FISCAL.distEstado() } },
  'POST /api/dfe/pedir': async b => { gerente(b, 'pedir o XML da nota'); return FISCAL.distPedir(String(b.chave || '')) },
  'POST /api/dfe/xml': b => ({ xml: FISCAL.distXml(String(b.chave || '')) }),
  'GET /api/municipios': (b, q) => FISCAL.municipios(q.get('uf')),
  'GET /api/nfe55/lista': () => FISCAL.lista55(),
  'POST /api/nfe55/emitir': b => emitirNfe55(b),
  'POST /api/nfe55/cancelar': b => cancelarNfe55(b),
  'POST /api/nfe55/cce': b => { gerente(b, 'fazer carta de correção'); return FISCAL.cce55(String(b.chave || ''), b.texto) },
  'POST /api/nfe55/danfe': b => FISCAL.danfe55(String(b.chave || '')),
  'GET /api/nfe55/compras': () => comprasDev(),
  'GET /api/nfe55/vendas': () => { const t0 = Date.now() - 15 * 864e5; return rows('orders').filter(o => o.fat && o.st != 'canc' && Date.parse(o.fat.date) >= t0).sort((a, b) => String(b.fat.date).localeCompare(String(a.fat.date))).slice(0, 200).map(o => { const nf = FISCAL.daVenda(o.id); return { id: o.id, date: o.fat.date, total: o.total, cn: o.cn, cpf: o.cpf || '', canal: o.canal, items: o.items, pags: o.pags, nfce: nf && ['autorizada', 'contingencia'].includes(nf.st) ? nf.num : null } }) },
  'POST /api/nfe55/compra': b => compraDev(b.chave),
  'POST /api/fiscal/inutilizar': b => { gerente(b, 'inutilizar numeração'); return FISCAL.inutilizar(b) },
  'GET /api/fiscal/inutilizadas': () => FISCAL.inutLista(),
  'GET /api/ibpt': () => FISCAL.ibptStatus(),
  'POST /api/ibpt/testar': b => { gerente(b, 'testar o token do IBPT'); return FISCAL.ibptTestar() },
  'POST /api/ibpt/buscar': async b => { gerente(b, 'buscar tributos no IBPT'); const r = await FISCAL.ibptPreencher(500); return { ...r, status: FISCAL.ibptStatus() } },
  'POST /api/ibpt/importar': b => { gerente(b, 'importar a tabela IBPT'); return FISCAL.ibptImportar(b) },
  'POST /api/ibpt/atualizar': async b => { gerente(b, 'atualizar a tabela IBPT'); const r = await FISCAL.ibptAtualizar(true); return { ...r, status: FISCAL.ibptStatus() } },
  'GET /api/nfce/lista': (b, q) => FISCAL.lista({ de: q.get('de'), ate: q.get('ate') }),
  'GET /api/nfce/venda': (b, q) => FISCAL.daVenda(q.get('id') || '') || {},
  'POST /api/cliente': b => salvarCliente(b),
  'GET /api/fiado/saldos': () => saldos(),
  'GET /api/fiado/extrato': (b, q) => { const cid = q.get('cid'); const l = rows('fiado', "where json_extract(data,'$.cid')=?", cid).sort((a, b) => String(a.date).localeCompare(String(b.date))); let s = 0; return l.map(f => ({ ...f, saldo: (s = r2(s + (+f.valor || 0))) })) },
  'GET /api/fiado/saldo': (b, q) => ({ saldo: saldoFiado(q.get('cid')) }),
  'POST /api/fiado/receber': b => lancFiado(b, 'pagamento'),
  'POST /api/fiado/ajuste': b => lancFiado(b, 'ajuste'),
  'POST /api/caixa': b => movimento(b),
  'POST /api/sync': async () => { await syncNow(); return status() },
  'POST /api/outbox/retry': b => { db.prepare('update outbox set err=null where seq=?').run(+b.seq); soon(); return status() },
  'POST /api/outbox/discard': b => {
    const r = db.prepare('select * from outbox where seq=?').get(+b.seq); if (!r) return status();
    tx(() => { db.prepare('delete from outbox where seq=?').run(r.seq); limpaDirty(r) });
    log('descartado da fila', r.kind, r.ref); return status();
  },
  'GET /api/printers': () => printers(),
  'GET /api/prn': () => prnCfg(),
  'POST /api/prn': b => { const c = { mode: b.mode == 'escpos' ? 'escpos' : 'browser', name: String(b.name || ''), cols: [32, 42, 48].includes(+b.cols) ? +b.cols : 48, ascii: b.ascii !== false, drawer: !!b.drawer }; kvSet('prn', c); return c },
  'POST /api/print': async b => { const c = prnCfg(); if (!c.name) throw new Error('Escolha a impressora nos ajustes.'); await sendRaw(c.name, escpos(b.spec, { ...c, drawer: c.drawer && b.drawer })); return { ok: true } },
  'POST /api/gaveta': async () => { const c = prnCfg(); if (!c.name) throw new Error('Escolha a impressora nos ajustes.'); await sendRaw(c.name, Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa])); return { ok: true } },
};
const server = http.createServer(async (req, res) => {
  try {
    const ra = req.socket.remoteAddress || '', local = /^(127\.|::1$|::ffff:127\.)/.test(ra);
    const u = new URL(req.url, 'http://localhost'), key = req.method + ' ' + u.pathname;
    if (!local) {
      // outro computador da loja: só a rede local, e só caixa pareado (exceto procurar/parear)
      if (!REDE || !privado(ra) || !u.pathname.startsWith('/api/')) { res.writeHead(403); return res.end('Acesso negado') }
      if (!['/api/descoberta', '/api/parear'].includes(u.pathname)) {
        req.terminal = terminalDe(req.headers['x-pdv-terminal'], ra.replace(/^::ffff:/, ''));
        if (!req.terminal) { res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'x-pdv-motivo': 'terminal' }); return res.end(JSON.stringify({ error: 'Este caixa não está autorizado. Conecte de novo com o código da Gestão do servidor.' })) }
      }
    } else if (!okHost(req.headers.host)) { res.writeHead(403); return res.end('Acesso negado') }
    if (req.method == 'GET' && u.pathname == '/api/som') {      // toque de pedido enviado pela loja (MP3)
      const t = kvGet('toque'), f = path.join(DATA, 'toque.bin');
      if (!t || !fs.existsSync(f)) { res.writeHead(404, { 'cache-control': 'no-cache' }); return res.end() }
      res.writeHead(200, { 'content-type': t.mime, 'cache-control': u.searchParams.get('v') == t.v ? 'public, max-age=31536000, immutable' : 'no-cache' });
      return fs.createReadStream(f).pipe(res);
    }
    if (req.method == 'GET' && u.pathname == '/api/foto') {
      const r = db.prepare('select img, v from fotos where id=?').get(u.searchParams.get('id') || '');
      const m = r && /^data:(image\/[a-z]+);base64,(.*)$/s.exec(r.img);
      if (!m) { res.writeHead(404, { 'cache-control': 'no-cache' }); return res.end() }
      res.writeHead(200, { 'content-type': m[1], 'cache-control': u.searchParams.get('v') == r.v ? 'public, max-age=31536000, immutable' : 'no-cache' });
      return res.end(Buffer.from(m[2], 'base64'));
    }
    if (req.method == 'GET' && u.pathname == '/api/ibpt/exportar') {
      try {
        gerente({ token: u.searchParams.get('t') || '' }, 'exportar a tabela IBPT');
        const x = FISCAL.ibptExportar();
        res.writeHead(200, { 'content-type': 'text/csv; charset=iso-8859-1', 'content-length': x.buf.length, 'content-disposition': `attachment; filename="${x.nome}"` });
        return res.end(x.buf);
      } catch (e) { return send(res, 400, { error: e.message }) }
    }
    if (req.method == 'GET' && u.pathname == '/api/backup/baixar') {
      try {
        gerente({ token: u.searchParams.get('t') || '' }, 'baixar o backup');
        const a = bkArquivo(u.searchParams.get('f'), u.searchParams.get('o')), st = fs.statSync(a);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename="AdaptaSysMercado-${path.basename(a)}"` });
        return fs.createReadStream(a).pipe(res);
      } catch (e) { return send(res, 400, { error: e.message }) }
    }
    if (req.method == 'GET' && (u.pathname == '/api/nfce/xml' || u.pathname == '/api/fiscal/zip')) {
      try {
        if (u.pathname == '/api/nfce/xml') { const ch = (u.searchParams.get('chave') || '').replace(/\D/g, ''); const x = FISCAL.xmlDe(ch); res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'content-disposition': `attachment; filename="${ch}-nfce.xml"` }); return res.end(x) }
        const mes = u.searchParams.get('mes') || '', z = FISCAL.zipMes(mes);
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="NFCe-${mes}.zip"` }); return res.end(z.buf);
      } catch (e) { return send(res, 400, { error: e.message }) }
    }
    if (u.pathname.startsWith('/api/')) {
      if (req.method == 'POST') { const o = req.headers.origin; if (o && !okHost(o.replace(/^https?:\/\//, ''))) return send(res, 403, { error: 'Origem não permitida' }) }
      const fn = ROUTES[key]; if (!fn) return send(res, 404, { error: 'Rota não encontrada' });
      const b = req.method == 'POST' ? await body(req) : {};
      if (b && typeof b == 'object') { b.__local = local && !req.terminal; if (req.terminal) b.__term = req.terminal.nome }
      try { return send(res, 200, await fn(b, u.searchParams)) } catch (e) { return send(res, 400, { error: e.message }) }
    }
    let p = decodeURIComponent(u.pathname); if (p == '/') { res.writeHead(302, { location: '/pdv.html' }); return res.end() }
    if (!sbOk() && /^\/(pdv|gestao)\.html$/.test(p)) { res.writeHead(302, { location: '/configurar.html' }); return res.end() }   // primeira configuração
    if (p == '/config.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return res.end('window.MO_CFG=' + JSON.stringify({ sbUrl: CFG.sbUrl || '', sbKey: CFG.sbKey || '', fakeDom: CFG.fakeDom || '', produto: 'AdaptaSys Mercado' }) + ';') }
    const f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Não encontrado') }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { log('erro http', e.message); try { send(res, 500, { error: 'Erro interno' }) } catch (x) { } }
});
/* porta: tenta a configurada e, se o Windows bloquear (portas reservadas), usa outra e anota em dados\porta.txt */
const PORTS = [...new Set([+CFG.port || 7070, 8765, 18765, 28765, 5765, 3765, 9876, 6543])];
let PORT = 0;
async function jaRodando(p) { try { const r = await fetch(`http://127.0.0.1:${p}/api/status`, { signal: AbortSignal.timeout(1500) }); const j = await r.json(); return !!(j && j.local) } catch (e) { return false } }
function tryListen(k) {
  if (k >= PORTS.length) { log('ERRO: nenhuma porta livre para o servidor do PDV:', PORTS.join(', ')); process.exit(1) }
  const p = PORTS[k];
  const onErr = async e => {
    server.removeListener('listening', onOk);
    if (e.code == 'EADDRINUSE' && await jaRodando(p)) { log('O servidor do PDV já está rodando na porta ' + p + '.'); process.exit(3) }
    log(`porta ${p} indisponível (${e.code}), tentando outra...`); tryListen(k + 1);
  };
  const onOk = () => {
    server.removeListener('error', onErr); PORT = p;
    for (const f of [path.join(DATA, 'porta.txt'), process.env.PDV_PUB && path.join(process.env.PDV_PUB, 'porta.txt')].filter(Boolean)) try { fs.writeFileSync(f, String(p)) } catch (e) { }
    server.on('error', e => log('erro', e.message));
    if (!REDE && CFG.host == '127.0.0.1') { const s6 = http.createServer(server.listeners('request')[0]); s6.on('error', () => { }); s6.listen(p, '::1') }
    LIGADO = true; try { fs.unlinkSync(path.join(DATA, 'erro-ao-ligar.txt')) } catch (e) { }
    log(`PDV local pronto: http://localhost:${p}/pdv.html  ·  dados em ${DATA}`); syncNow();
  };
  server.once('error', onErr); server.once('listening', onOk);
  server.listen(p, REDE ? '0.0.0.0' : CFG.host);
}
if (process.env.PDV_SO_TESTAR) { console.log('TESTE OK: o servidor carregou sem erro (versao ' + VERSAO + ').'); process.exit(0) }
tryListen(0);
process.on('unhandledRejection', e => log('ERRO', (e && e.stack) || e));
const bye = () => { try { db.close() } catch (e) { } process.exit(0) };
process.on('SIGINT', bye); process.on('SIGTERM', bye);
module.exports = { escpos };
