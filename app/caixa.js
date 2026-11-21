'use strict';
/* =====================================================================
   CAIXA DA REDE (terminal) · Mercado Online
   Roda nos outros computadores da loja. Mostra as telas do PDV, imprime na
   impressora DESTE computador e repassa todo o resto para o servidor da loja
   (o computador principal), que guarda o banco, emite as notas e sincroniza.
   O pareamento usa um código de 6 números mostrado na Gestão do servidor.
   ===================================================================== */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { spawn } = require('child_process');

module.exports = function caixa({ CFG, DATA, ROOT, log, J, cfgFile }) {
  const PUB = path.join(ROOT, 'public');
  const { escpos, sendRaw, printers } = require('./impressao')({ DATA, log, J });
  const PRNF = path.join(DATA, 'impressora.json');
  const prnCfg = () => Object.assign({ mode: 'browser', name: '', cols: 48, ascii: true, drawer: false }, J(fs.existsSync(PRNF) ? fs.readFileSync(PRNF, 'utf8') : '') || {});
  const salvarCfg = c => { Object.assign(CFG, c); const f = J(fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '') || {}; fs.writeFileSync(cfgFile, JSON.stringify({ ...f, ...c }, null, 2)) };
  const pareado = () => !!(CFG.servidor && CFG.chave);
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)) };
  const body = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 5e6) { no(new Error('Muito grande')); req.destroy() } }); req.on('end', () => ok(b ? J(b) || {} : {})) });
  const okHost = h => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(h || ''));

  /* procura o servidor da loja na rede local (só sai deste computador: não precisa de firewall aqui) */
  async function procurar() {
    const redes = new Set();
    for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) if (a.family == 'IPv4' && !a.internal && (/^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address) || String(process.env.PDV_REDES_EXTRA || '').split(',').filter(Boolean).some(x => a.address.startsWith(x)))) redes.add(a.address.split('.').slice(0, 3).join('.'));
    const alvos = []; for (const r of redes) for (let i = 1; i < 255; i++) for (const p of (CFG.portasBusca || [7070, 8765, 18765])) alvos.push(`http://${r}.${i}:${p}`);
    const achados = []; let k = 0;
    const um = async () => { while (k < alvos.length) { const u = alvos[k++]; try { const r = await fetch(u + '/api/descoberta', { signal: AbortSignal.timeout(450) }); const j = await r.json(); if (j && (j.mercadoOnline || j.pdvMezzomo)) achados.push({ url: u, loja: j.loja, nome: j.nome }) } catch (e) { } } };
    await Promise.all(Array.from({ length: 96 }, um));
    return achados;
  }
  async function parear(b) {
    const url = String(b.url || '').replace(/\/+$/, ''); if (!/^http:\/\/[\d.]+:\d+$/.test(url)) throw new Error('Escolha o servidor da loja.');
    const r = await fetch(url + '/api/parear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codigo: String(b.codigo || ''), nome: String(b.nome || '').trim() || 'Caixa 2' }), signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'O servidor recusou.');
    salvarCfg({ servidor: url, chave: j.chave, nome: j.nome, loja: j.loja }); log('caixa pareado com', url, 'como', j.nome);
    return { ok: true, nome: j.nome };
  }
  /* repassa a chamada para o servidor da loja */
  function repassa(req, res, extra) {
    const u = new URL(CFG.servidor + req.url);
    const h = { ...req.headers, host: u.host, 'x-pdv-terminal': CFG.chave, 'x-pdv-nome': encodeURIComponent(CFG.nome || '') }; delete h.origin; delete h.referer;
    const up = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: h, timeout: 70000 }, r => {
      if (extra && r.statusCode == 200) { let b = ''; r.setEncoding('utf8'); r.on('data', c => b += c); r.on('end', () => { const j = J(b) || {}; send(res, 200, extra(j)) }); return }
      if (r.statusCode == 403 && /terminal/i.test(r.headers['x-pdv-motivo'] || '')) { salvarCfg({ chave: '' }); log('o servidor não reconhece mais este caixa: precisa parear de novo') }
      res.writeHead(r.statusCode, r.headers); r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('tempo esgotado')));
    up.on('error', e => { if (!res.headersSent && extra) return send(res, 200, { local: true, caixaRede: true, pareado: true, semServidor: true, prn: prnCfg(), terminal: { nome: CFG.nome, servidor: CFG.servidor }, error: 'Servidor da loja não respondeu' }); if (!res.headersSent) send(res, 503, { error: 'O computador servidor da loja não respondeu (' + (e.code || e.message) + '). Ele precisa estar ligado e na mesma rede.' }) });
    req.pipe(up);
  }
  const LOCAL = {
    'GET /api/caixa/info': () => ({ pareado: pareado(), servidor: CFG.servidor || '', nome: CFG.nome || '', loja: CFG.loja || '' }),
    'GET /api/caixa/procurar': () => procurar(),
    'POST /api/caixa/parear': b => parear(b),
    'POST /api/caixa/desparear': () => { salvarCfg({ chave: '', servidor: '' }); return { ok: true } },
    'GET /api/printers': () => printers(),
    'GET /api/prn': () => prnCfg(),
    'POST /api/prn': b => { const c = { mode: b.mode == 'escpos' ? 'escpos' : 'browser', name: String(b.name || ''), cols: [32, 42, 48].includes(+b.cols) ? +b.cols : 48, ascii: b.ascii !== false, drawer: !!b.drawer }; fs.writeFileSync(PRNF, JSON.stringify(c)); return c },
    'POST /api/print': async b => { const c = prnCfg(); if (!c.name) throw new Error('Escolha a impressora nos ajustes.'); await sendRaw(c.name, escpos(b.spec, { ...c, drawer: c.drawer && b.drawer })); return { ok: true } },
    'POST /api/gaveta': async () => { const c = prnCfg(); if (!c.name) throw new Error('Escolha a impressora nos ajustes.'); await sendRaw(c.name, Buffer.from([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa])); return { ok: true } },
    'POST /api/abrir': () => { throw new Error('NAO_WINDOWS') },
    'POST /api/reiniciar': () => { log('caixa: reiniciar'); setTimeout(() => process.exit(0), 300); return { ok: true } },
  };
  const server = http.createServer(async (req, res) => {
    try {
      if (!okHost(req.headers.host)) { res.writeHead(403); return res.end('Acesso negado') }
      const u = new URL(req.url, 'http://localhost'), key = req.method + ' ' + u.pathname;
      if (u.pathname.startsWith('/api/')) {
        if (LOCAL[key]) { const b = req.method == 'POST' ? await body(req) : {}; try { return send(res, 200, await LOCAL[key](b, u.searchParams)) } catch (e) { return send(res, 400, { error: e.message }) } }
        if (!pareado()) return send(res, u.pathname == '/api/status' ? 200 : 409, u.pathname == '/api/status' ? { local: true, caixaRede: true, pareado: false } : { error: 'Este caixa ainda não foi conectado ao servidor da loja.' });
        if (u.pathname == '/api/status') return repassa(req, res, j => ({ ...j, prn: prnCfg(), terminal: { nome: CFG.nome, servidor: CFG.servidor }, caixaRede: true }));
        return repassa(req, res);
      }
      let p = decodeURIComponent(u.pathname);
      if (p == '/' || (!pareado() && /^\/(pdv|gestao)\.html$/.test(p))) { res.writeHead(302, { location: pareado() ? '/pdv.html' : '/parear.html' }); return res.end() }
      const f = path.normalize(path.join(PUB, p));
      if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Não encontrado') }
      res.writeHead(200, { 'content-type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    } catch (e) { log('erro http', e.message); try { send(res, 500, { error: 'Erro interno' }) } catch (x) { } }
  });
  const PORTS = [...new Set([+CFG.port || 7070, 8765, 18765, 28765, 5765, 3765, 9876, 6543])];
  const tryListen = k => {
    if (k >= PORTS.length) { log('ERRO: nenhuma porta livre'); process.exit(1) }
    const p = PORTS[k];
    server.once('error', e => { log(`porta ${p} indisponível (${e.code})`); tryListen(k + 1) });
    server.listen(p, '127.0.0.1', () => {
      server.removeAllListeners('error'); server.on('error', e => log('erro', e.message));
      for (const f of [path.join(DATA, 'porta.txt'), process.env.PDV_PUB && path.join(process.env.PDV_PUB, 'porta.txt')].filter(Boolean)) try { fs.writeFileSync(f, String(p)) } catch (e) { }
      const s6 = http.createServer(server.listeners('request')[0]); s6.on('error', () => { }); s6.listen(p, '::1');
      log(`CAIXA DA REDE pronto: http://localhost:${p}/pdv.html · servidor ${CFG.servidor || '(ainda não conectado)'}`);
    });
  };
  tryListen(0);
};
