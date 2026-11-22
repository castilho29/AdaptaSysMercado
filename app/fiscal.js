'use strict';
/* NFC-e (modelo 65) e NF-e (55) direto na SEFAZ — AdaptaSys Mercado
   Monta o XML 4.00, assina com o certificado A1, gera o QR Code (versão 2, com CSC),
   envia para a autorizadora da UF (tabela das 27 UFs em sefaz.json), entra em contingência offline quando
   não há comunicação e reenvia sozinho depois. Referência: leiaute NF-e 4.00 (MOC),
   Manual do DANFE NFC-e / QR Code e a implementação do NFePHP (sped-nfe). */
const fs = require('fs'), path = require('path'), https = require('https'), crypto = require('crypto'), zlib = require('zlib');
const forge = require('./lib/forge');

const NS = 'http://www.portalfiscal.inf.br/nfe', DS = 'http://www.w3.org/2000/09/xmldsig#';
const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
/* autorizadoras de NFC-e e NF-e das 27 UFs (produção e homologação), URL do QR Code e da consulta pela chave.
   Tabela gerada da tabela do projeto NFePHP (sped-nfe/storage, LGPL-3.0) — ver sefaz.json. */
const TAB = JSON.parse(fs.readFileSync(path.join(__dirname, 'sefaz.json'), 'utf8')).ufs;
const UFS = Object.fromEntries(Object.entries(TAB).map(([uf, t]) => [uf, {
  cUF: t.cUF, aut65: t.aut65, aut55: t.aut55,
  ws: { 1: t.nfce[1], 2: t.nfce[2] }, ws55: { 1: t.nfe[1], 2: t.nfe[2] },
  qr: { 1: t.nfce[1].qr, 2: t.nfce[2].qr }, qrVer: { 1: t.nfce[1].qrVer || 2, 2: t.nfce[2].qrVer || 2 },
  urlChave: { 1: t.urlChave[1], 2: t.urlChave[2] }
}]));
const TPAG = { Dinheiro: '01', 'Crédito': '03', 'Débito': '04', Fiado: '05', Pix: '17' };
const UN = { un: 'UN', kg: 'KG', g: 'G', L: 'L', pct: 'PCT', cx: 'CX' };

module.exports = function fiscal(D) {
  const { db, DATA, kvGet, kvSet, log, J, tx, one } = D;
  db.exec(`create table if not exists nfce(chave text primary key, venda text, serie integer, num integer, st text, data text not null, xml text, updated_at text);
create index if not exists nfce_venda on nfce(venda);`);
  const CERTF = path.join(DATA, 'certificado.pfx'), XMLD = path.join(DATA, 'xml');

  /* ---------- configuração ---------- */
  const DEF = { ibptModo: 'auto', ibptToken: '', on: false, amb: 2, serie: 2, num: 1, serie55: 2, num55: 1, cscId: '', csc: '', cnpj: '', ie: '', xNome: '', xFant: '', xLgr: '', nro: '', xBairro: '', cMun: '', xMun: '', uf: '', qrVer: 'auto', cep: '', fone: '', crt: 1, cfop: '5102', csosn: '102', rtCnpj: '', rtContato: '', rtEmail: '', rtFone: '', distOn: false, distCiencia: true, infCpl: 'Documento emitido por ME ou EPP optante pelo Simples Nacional.' };
  const cfg = () => ({ ...DEF, ...(kvGet('fiscal') || {}) });
  const dg = v => String(v ?? '').replace(/\D/g, '');
  function cfgPublic() {
    const c = cfg(), ci = certInfo();
    return { ...c, ibptToken: c.ibptToken ? '••••' + String(c.ibptToken).slice(-4) : '', temIbptToken: !!c.ibptToken, csc: c.csc ? '••••' + String(c.csc).slice(-4) : '', temCsc: !!c.csc, certSenha: undefined, cert: ci, pendentes: pendentes().length, pendHoras: pendHoras(), uf: c.uf };
  }
  function salvarCfg(b) {
    const c = cfg(), n = { ...c };
    for (const k of Object.keys(DEF)) if (k in b && k != 'csc' && k != 'ibptToken') n[k] = b[k];
    if (typeof b.ibptToken == 'string' && !/^••••/.test(b.ibptToken)) n.ibptToken = b.ibptToken.trim();
    if (b.ibptTokenRemover) n.ibptToken = '';
    if (!['auto', 'api', 'tabela', 'off'].includes(n.ibptModo)) n.ibptModo = 'auto';
    if (b.csc && !/^••••/.test(b.csc)) n.csc = String(b.csc).trim();
    n.amb = +n.amb == 1 ? 1 : 2; n.serie = Math.max(0, Math.min(999, +n.serie || 0)); n.serie55 = Math.max(0, Math.min(999, +n.serie55 || 0)); n.num55 = Math.max(1, Math.min(999999999, +n.num55 || 1)); n.num = Math.max(1, Math.min(999999999, +n.num || 1));
    n.cnpj = dg(n.cnpj); n.ie = dg(n.ie); n.cep = dg(n.cep); n.fone = dg(n.fone); n.cMun = dg(n.cMun); n.crt = [1, 2, 3, 4].includes(+n.crt) ? +n.crt : 1;
    n.distOn = !!n.distOn; n.distCiencia = n.distCiencia !== false; n.cscId = dg(n.cscId); n.rtCnpj = dg(n.rtCnpj); n.rtFone = dg(n.rtFone);
    n.uf = String(n.uf || '').toUpperCase(); if (n.uf && !UFS[n.uf]) throw new Error('UF inválida: ' + n.uf);
    n.qrVer = ['2', '3'].includes(String(n.qrVer)) ? String(n.qrVer) : 'auto';
    if (n.on) {
      const falta = [['uf', 'Estado (UF)'], ['cnpj', 'CNPJ'], ['ie', 'Inscrição estadual'], ['xNome', 'Razão social'], ['xLgr', 'Rua'], ['nro', 'Número'], ['xBairro', 'Bairro'], ['cMun', 'Código do município'], ['cep', 'CEP'], ['cscId', 'ID do CSC'], ['csc', 'CSC']].filter(([k]) => !n[k]).map(([, t]) => t);
      if (falta.length) throw new Error('Para ligar a NFC-e preencha: ' + falta.join(', ') + '.');
      if (!fs.existsSync(CERTF)) throw new Error('Envie o certificado digital A1 antes de ligar a NFC-e.');
    }
    const trocouUf = n.uf != c.uf;
    kvSet('fiscal', n); if (trocouUf && n.uf) { try { if (!ibptEmbutida()) setTimeout(() => ibptAtualizar(true).catch(e => log('IBPT:', e.message)), 500) } catch (e) { log('IBPT:', e.message) } }
    log('fiscal: ajustes salvos', n.uf, n.on ? 'LIGADA' : 'desligada', n.amb == 1 ? 'PRODUÇÃO' : 'homologação', 'série', n.serie, 'próx.', n.num);
    return cfgPublic();
  }

  /* ---------- certificado A1 ---------- */
  let CERT = null;
  /* a senha do certificado fica criptografada pelo próprio Windows (DPAPI): só este computador abre */
  function dpapi(modo, b64) {
    if (process.platform != 'win32') return null;
    const sc = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String($env:PDV_IN); $o=[Security.Cryptography.ProtectedData]::${modo}($b,$null,'LocalMachine'); [Convert]::ToBase64String($o)`;
    try { const r = require('child_process').spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', sc], { env: { ...process.env, PDV_IN: b64 }, encoding: 'utf8', timeout: 20000, windowsHide: true }); return r.status == 0 && r.stdout.trim() ? r.stdout.trim() : null } catch (e) { return null }
  }
  function guardaSenha(senha) { const dp = dpapi('Protect', Buffer.from(String(senha || ''), 'utf8').toString('base64')); if (dp) { kvSet('certSenhaDp', dp); kvSet('certSenha', '') } else kvSet('certSenha', String(senha || '')) }
  function senhaCert() {
    const dp = kvGet('certSenhaDp'); if (dp) { const x = dpapi('Unprotect', dp); if (x != null) return Buffer.from(x, 'base64').toString('utf8') }
    const p = kvGet('certSenha') || ''; if (p && process.platform == 'win32') guardaSenha(p); return p;
  }
  function lerPfx(buf, senha) {
    let p12;
    try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buf.toString('binary'))), false, senha) }
    catch (e) { throw new Error(/password|mac|Invalid/i.test(e.message) ? 'Senha do certificado incorreta.' : 'Não foi possível ler o certificado (' + e.message + ').') }
    const keys = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])];
    const certs = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || [];
    const key = keys[0] && keys[0].key; if (!key) throw new Error('O arquivo não tem a chave privada (precisa ser o A1 .pfx).');
    const cert = (certs.find(c => c.cert && c.cert.publicKey && c.cert.publicKey.n && c.cert.publicKey.n.equals(key.n)) || certs[0] || {}).cert;
    if (!cert) throw new Error('Certificado não encontrado dentro do arquivo.');
    const cn = (cert.subject.getField('CN') || {}).value || '';
    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
    return {
      keyPem: forge.pki.privateKeyToPem(key), certPem: forge.pki.certificateToPem(cert), certB64: Buffer.from(der, 'binary').toString('base64'),
      info: { nome: cn.split(':')[0], cnpj: (cn.match(/:(\d{14})/) || [])[1] || '', validade: cert.validity.notAfter.toISOString(), emissor: (cert.issuer.getField('CN') || {}).value || '' }
    };
  }
  function cert() {
    if (CERT) return CERT;
    if (!fs.existsSync(CERTF)) throw new Error('Certificado digital não enviado (Gestão > Fiscal).');
    CERT = lerPfx(fs.readFileSync(CERTF), senhaCert()); return CERT;
  }
  function certInfo() { try { return cert().info } catch (e) { return fs.existsSync(CERTF) ? { erro: e.message } : null } }
  function salvarCert(b) {
    const buf = Buffer.from(String(b.b64 || '').replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length < 500) throw new Error('Escolha o arquivo do certificado (.pfx ou .p12).');
    const c = lerPfx(buf, String(b.senha || ''));
    if (new Date(c.info.validade) < new Date()) throw new Error('Este certificado venceu em ' + new Date(c.info.validade).toLocaleDateString('pt-BR') + '.');
    fs.writeFileSync(CERTF, buf); guardaSenha(b.senha); CERT = c; AG = null;
    const f = cfg(); if (!f.cnpj && c.info.cnpj) kvSet('fiscal', { ...f, cnpj: c.info.cnpj });
    log('fiscal: certificado instalado', c.info.nome, 'validade', c.info.validade.slice(0, 10)); return c.info;
  }

  /* ---------- XML ---------- */
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const txt = (s, max) => esc(String(s ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max));
  const el = (n, v) => v === undefined || v === null || v === '' ? '' : `<${n}>${v}</${n}>`;
  const f2 = n => (Math.round((+n || 0) * 100) / 100).toFixed(2), f4 = n => (+n || 0).toFixed(4);
  const r2 = n => Math.round((+n || 0) * 100) / 100;
  function dh(d = new Date()) {
    const o = -d.getTimezoneOffset(), p = n => String(Math.abs(n)).padStart(2, '0'), l = new Date(d.getTime() + o * 60000);
    return l.toISOString().slice(0, 19) + (o >= 0 ? '+' : '-') + p(Math.trunc(o / 60)) + ':' + p(o % 60);
  }
  function dv11(s) { let w = 2, t = 0; for (let i = s.length - 1; i >= 0; i--) { t += +s[i] * w; w = w == 9 ? 2 : w + 1 } const r = t % 11; return r < 2 ? 0 : 11 - r }
  function gtinOk(g) { g = dg(g); if (![8, 12, 13, 14].includes(g.length) || /^0+$/.test(g)) return false; let t = 0; for (let i = 0; i < g.length - 1; i++) t += +g[g.length - 2 - i] * (i % 2 ? 1 : 3); return (10 - t % 10) % 10 == +g[g.length - 1] }

  /* rateia um valor (desconto/acréscimo) entre os itens, proporcional ao valor de cada um */
  function ratear(valor, bases) {
    const tot = bases.reduce((s, b) => s + b, 0); if (!(valor > 0) || !tot) return bases.map(() => 0);
    const out = bases.map(b => Math.floor(valor * b / tot * 100) / 100); let rest = Math.round((valor - out.reduce((s, x) => s + x, 0)) * 100);
    for (let i = 0; rest > 0; i = (i + 1) % out.length) { if (bases[i] > 0) { out[i] = r2(out[i] + 0.01); rest-- } }
    return out;
  }

  /* ===== produtos de PARCEIRO (outro CNPJ) não entram na NFC-e da loja: a nota deles é do parceiro =====
     A nota da loja leva só os itens da loja; desconto e pagamentos são rateados; a taxa de entrega é da loja. */
  const ehParc = i => { if (i.parc) return true; const p = (one('products', i.pid) || {}).data || {}; return !!p.parc };
  function parteLoja(v) {
    const it = (v.items || []).filter(i => +i.q > 0), loja = it.filter(i => !ehParc(i));
    if (loja.length == it.length) return v;
    if (!loja.length) return null;
    const vi = i => r2(+i.t || (+i.q * +i.p)), sub = r2(it.reduce((s, i) => s + vi(i), 0)), subL = r2(loja.reduce((s, i) => s + vi(i), 0));
    const desc = sub > 0 ? r2((+v.desc || 0) * subL / sub) : 0, taxa = r2(+v.taxa || 0), totL = r2(subL - desc + taxa), totAll = r2(sub - (+v.desc || 0) + taxa), k = totAll > 0 ? totL / totAll : 1;
    let pags = (v.pags || []).filter(g => +g.v > 0).map(g => ({ ...g, v: r2(+g.v * k) }));
    const dif = r2(totL - pags.reduce((s, g) => s + g.v, 0)); if (pags.length && dif) { const g = pags.reduce((a, b) => b.v > a.v ? b : a); g.v = r2(g.v + dif) }
    const troco = r2(+v.troco || 0); let usou = false;
    pags = pags.map(g => { if (g.f != 'Dinheiro') return g; const r = r2(g.v + (usou ? 0 : troco)); usou = true; return { ...g, r } });
    return { ...v, items: loja, desc, pags, total: totL, parcTotal: r2(totAll - totL) };
  }
  function montar(v, o) {
    const c = cfg(), U = UFS[c.uf], tpAmb = c.amb, d = o.dhEmi || new Date();
    const itens = (v.items || []).filter(i => +i.q > 0);
    if (!itens.length) throw new Error('Venda sem itens.');
    const semNcm = [];
    const prods = itens.map(i => { const p = (one('products', i.pid) || {}).data || {}; const ncm = dg(p.ncm); if (ncm.length != 8) semNcm.push(i.n); return p });
    if (semNcm.length) throw new Error('NCM_FALTA: Produtos sem NCM (8 números): ' + [...new Set(semNcm)].slice(0, 6).join(', ') + '. Cadastre na Gestão > Produtos.');
    const vProdL = itens.map(i => r2(+i.t || (+i.q * +i.p)));
    const vDescL = ratear(r2(+v.desc || 0), vProdL), vOutL = ratear(r2(+v.taxa || 0), vProdL);
    const vProd = r2(vProdL.reduce((s, x) => s + x, 0)), vDesc = r2(vDescL.reduce((s, x) => s + x, 0)), vOutro = r2(vOutL.reduce((s, x) => s + x, 0));
    const vNF = r2(vProd - vDesc + vOutro);
    if (Math.abs(vNF - r2(v.total)) > 0.011) throw new Error(`Total da venda (${f2(v.total)}) não confere com os itens (${f2(vNF)}).`);
    const cNF = o.cNF || String(crypto.randomInt(10000000, 99999999)), tpEmis = o.tpEmis || 1;
    const aamm = d.getFullYear().toString().slice(2) + String(d.getMonth() + 1).padStart(2, '0');
    const base = String(U.cUF) + aamm + c.cnpj.padStart(14, '0') + '65' + String(c.serie).padStart(3, '0') + String(o.num).padStart(9, '0') + tpEmis + cNF;
    const chave = base + dv11(base);
    const doc = dg(v.cpf);
    const trib = { fed: 0, est: 0, mun: 0, semNcm: 0 }, im = ibptMeta();
    const det = itens.map((i, k) => {
      const p = prods[k], u = UN[i.u] || UN[p.u] || 'UN', g = gtinOk(p.bar) ? dg(p.bar) : 'SEM GTIN';
      const q = +i.q, vu = Math.abs(r2(q * (+i.p || 0)) - vProdL[k]) <= 0.01 && +i.p > 0 ? +i.p : vProdL[k] / q, csosn = String(p.csosn || c.csosn), cfop = String(p.cfop || (csosn == '500' ? '5405' : c.cfop));
      const icms = csosn == '500' ? `<ICMSSN500><orig>${+p.orig || 0}</orig><CSOSN>500</CSOSN></ICMSSN500>`
        : `<ICMSSN102><orig>${+p.orig || 0}</orig><CSOSN>${['102', '103', '300', '400'].includes(csosn) ? csosn : '102'}</CSOSN></ICMSSN102>`;
      const base = r2(vProdL[k] - vDescL[k] + vOutL[k]), al = ibptDe(dg(p.ncm), p.ex, p.orig);
      let vt = 0; if (al) { trib.src = trib.src || {}; trib.src[al.src] = al; const a = r2(base * al.fed / 100), b = r2(base * al.est / 100), c2 = r2(base * al.mun / 100); trib.fed += a; trib.est += b; trib.mun += c2; vt = r2(a + b + c2) } else trib.semNcm++;
      return `<det nItem="${k + 1}"><prod><cProd>${txt(p.cod || i.pid, 60)}</cProd><cEAN>${g}</cEAN><xProd>${tpAmb == 2 && k == 0 ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : txt(i.n || p.n, 120)}</xProd><NCM>${dg(p.ncm)}</NCM>${el('CEST', dg(p.cest).length == 7 ? dg(p.cest) : '')}<CFOP>${cfop}</CFOP><uCom>${u}</uCom><qCom>${f4(q)}</qCom><vUnCom>${vu.toFixed(10).replace(/0{1,8}$/, '')}</vUnCom><vProd>${f2(vProdL[k])}</vProd><cEANTrib>${g}</cEANTrib><uTrib>${u}</uTrib><qTrib>${f4(q)}</qTrib><vUnTrib>${vu.toFixed(10).replace(/0{1,8}$/, '')}</vUnTrib>${vDescL[k] ? `<vDesc>${f2(vDescL[k])}</vDesc>` : ''}${vOutL[k] ? `<vOutro>${f2(vOutL[k])}</vOutro>` : ''}<indTot>1</indTot></prod><imposto>${vt > 0 ? `<vTotTrib>${f2(vt)}</vTotTrib>` : ''}<ICMS>${icms}</ICMS></imposto></det>`;
    }).join('');
    ['fed', 'est', 'mun'].forEach(k => trib[k] = r2(trib[k])); trib.tot = r2(trib.fed + trib.est + trib.mun);
    { const ts = trib.src || {}; delete trib.src; if (ts.tabela && im) { trib.fonte = im.fonte; trib.chave = im.chave; trib.versao = im.versao } else if (ts.api) { trib.fonte = ts.api.fonte || 'IBPT'; trib.chave = ts.api.chave || ''; trib.api = true } else if (im) { trib.fonte = im.fonte; trib.chave = im.chave; trib.versao = im.versao } }
    const cpl = [c.infCpl, trib.tot > 0 ? `Trib aprox R$ ${f2(trib.fed).replace('.', ',')} Federal, R$ ${f2(trib.est).replace('.', ',')} Estadual e R$ ${f2(trib.mun).replace('.', ',')} Municipal. Fonte: ${trib.fonte || 'IBPT'} ${trib.chave || ''}`.trim() : ''].filter(Boolean).join(' ');
    // pagamentos: dinheiro entra com o valor recebido; o troco sai em vTroco
    const pags = (v.pags || []).filter(g => +g.v > 0);
    const detPag = (pags.length ? pags : [{ f: 'Dinheiro', v: vNF }]).map(g => {
      const t = TPAG[g.f] || '99', val = g.f == 'Dinheiro' ? (+g.r || +g.v) : +g.v;
      return `<detPag><tPag>${t}</tPag>${t == '99' ? `<xPag>${txt(g.f, 60)}</xPag>` : ''}<vPag>${f2(val)}</vPag>${['03', '04', '17'].includes(t) ? '<card><tpIntegra>2</tpIntegra></card>' : ''}</detPag>`;
    }).join('');
    const troco = r2(+v.troco || 0);
    const dest = doc.length == 11 ? `<dest><CPF>${doc}</CPF><indIEDest>9</indIEDest></dest>` : doc.length == 14 ? `<dest><CNPJ>${doc}</CNPJ><indIEDest>9</indIEDest></dest>` : '';
    const ender = `<enderEmit><xLgr>${txt(c.xLgr, 60)}</xLgr><nro>${txt(c.nro, 60)}</nro><xBairro>${txt(c.xBairro, 60)}</xBairro><cMun>${c.cMun}</cMun><xMun>${txt(c.xMun, 60)}</xMun><UF>${c.uf}</UF><CEP>${c.cep}</CEP><cPais>1058</cPais><xPais>BRASIL</xPais>${el('fone', c.fone.length >= 6 ? c.fone : '')}</enderEmit>`;
    const respTec = c.rtCnpj && c.rtContato && c.rtEmail && c.rtFone ? `<infRespTec><CNPJ>${c.rtCnpj}</CNPJ><xContato>${txt(c.rtContato, 60)}</xContato><email>${txt(c.rtEmail, 60)}</email><fone>${c.rtFone}</fone></infRespTec>` : '';
    const cont = tpEmis == 9 ? `<dhCont>${dh(o.dhCont || d)}</dhCont><xJust>${txt(o.xJust || 'Sem comunicacao com a SEFAZ no momento da venda', 256)}</xJust>` : '';
    const inf = `<infNFe Id="NFe${chave}" versao="4.00"><ide><cUF>${U.cUF}</cUF><cNF>${cNF}</cNF><natOp>VENDA</natOp><mod>65</mod><serie>${c.serie}</serie><nNF>${o.num}</nNF><dhEmi>${dh(d)}</dhEmi><tpNF>1</tpNF><idDest>1</idDest><cMunFG>${c.cMun}</cMunFG><tpImp>4</tpImp><tpEmis>${tpEmis}</tpEmis><cDV>${chave.slice(-1)}</cDV><tpAmb>${tpAmb}</tpAmb><finNFe>1</finNFe><indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>AdaptaSys Mercado 1.0</verProc>${cont}</ide>`
      + `<emit><CNPJ>${c.cnpj}</CNPJ><xNome>${txt(c.xNome, 60)}</xNome>${el('xFant', txt(c.xFant, 60))}${ender}<IE>${c.ie}</IE><CRT>${c.crt}</CRT></emit>${dest}${det}`
      + `<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${f2(vProd)}</vProd><vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>${f2(vDesc)}</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>${f2(vOutro)}</vOutro><vNF>${f2(vNF)}</vNF>${trib.tot > 0 ? `<vTotTrib>${f2(trib.tot)}</vTotTrib>` : ''}</ICMSTot></total>`
      + `<transp><modFrete>9</modFrete></transp><pag>${detPag}${troco > 0 ? `<vTroco>${f2(troco)}</vTroco>` : ''}</pag>${cpl ? `<infAdic><infCpl>${txt(cpl, 2000)}</infCpl></infAdic>` : ''}${respTec}</infNFe>`;
    const { sig, digest } = assinar(inf, NS);
    const qr = qrCode(c, chave, tpAmb, tpEmis, d, vNF, digest);
    const xml = `<NFe xmlns="${NS}">${inf}<infNFeSupl><qrCode>${esc(qr)}</qrCode><urlChave>${U.urlChave[tpAmb]}</urlChave></infNFeSupl>${sig}</NFe>`;
    return { xml, chave, cNF, qr, trib, vNF, vProd, vDesc, vOutro, troco, dhEmi: dh(d), tpEmis, tpAmb, doc };
  }

  /* assinatura XMLDSig (RSA-SHA1, C14N inclusiva) do elemento com atributo Id.
     O XML é gerado aqui já na forma canônica (sem espaços, atributos em ordem), então a forma
     C14N do elemento é ele mesmo com o namespace herdado declarado no início. */
  function assinar(elXml, ns) {
    const id = elXml.match(/^<(\w+) Id="([^"]+)"/); if (!id) throw new Error('Elemento sem Id para assinar');
    const can = elXml.replace(/^<(\w+) /, `<$1 xmlns="${ns}" `);
    const digest = crypto.createHash('sha1').update(can, 'utf8').digest('base64');
    const si = `<SignedInfo><CanonicalizationMethod Algorithm="${C14N}"></CanonicalizationMethod><SignatureMethod Algorithm="${DS}rsa-sha1"></SignatureMethod><Reference URI="#${id[2]}"><Transforms><Transform Algorithm="${DS}enveloped-signature"></Transform><Transform Algorithm="${C14N}"></Transform></Transforms><DigestMethod Algorithm="${DS}sha1"></DigestMethod><DigestValue>${digest}</DigestValue></Reference></SignedInfo>`;
    const k = cert();
    const sv = crypto.createSign('RSA-SHA1').update(si.replace('<SignedInfo>', `<SignedInfo xmlns="${DS}">`), 'utf8').sign(k.keyPem, 'base64');
    return { digest, sig: `<Signature xmlns="${DS}">${si}<SignatureValue>${sv}</SignatureValue><KeyInfo><X509Data><X509Certificate>${k.certB64}</X509Certificate></X509Data></KeyInfo></Signature>` };
  }
  /* QR Code. Versão 2 (NT 2015.002): online = chave|2|tpAmb|idCSC|hash ; offline acrescenta dia, valor e DigestValue.
     Versão 3 (NT 2025.001): online = chave|3|tpAmb (sem CSC). Em contingência offline o schema (PL_010) só aceita a versão 2.
     "auto" segue a tabela da UF (hoje: produção v2, homologação v3); dá para forçar 2 ou 3 nos ajustes fiscais. */
  function qrCode(c, chave, tpAmb, tpEmis, d, vNF, digest) {
    const U = UFS[c.uf], id = String(+c.cscId), url = String(U.qr[tpAmb]).replace(/\?p=$/, '');
    const ver = tpEmis == 9 ? 2 : (c.qrVer == '2' || c.qrVer == '3' ? +c.qrVer : U.qrVer[tpAmb]);
    if (ver == 3) return `${url}?p=${chave}|3|${tpAmb}`;
    if (!c.csc || !id) throw new Error('Falta o CSC nos ajustes fiscais (necessário para o QR Code versão 2).');
    const p = tpEmis == 9 ? [chave, 2, tpAmb, String(d.getDate()).padStart(2, '0'), f2(vNF), Buffer.from(digest, 'utf8').toString('hex'), id].join('|') : [chave, 2, tpAmb, id].join('|');
    const h = crypto.createHash('sha1').update(p + c.csc, 'utf8').digest('hex').toUpperCase();
    return `${url}?p=${p}|${h}`;
  }

  /* ---------- comunicação com a SEFAZ ---------- */
  let AG = null;
  const agent = () => AG || (AG = new https.Agent({ key: cert().keyPem, cert: cert().certPem, rejectUnauthorized: false, keepAlive: true, maxSockets: 2 }));
  class SemRede extends Error { }
  const ACAO = { NFeAutorizacao4: 'nfeAutorizacaoLote', NFeRetAutorizacao4: 'nfeRetAutorizacaoLote', NFeConsultaProtocolo4: 'nfeConsultaNF', NFeStatusServico4: 'nfeStatusServicoNF', NFeRecepcaoEvento4: 'nfeRecepcaoEvento', NFeInutilizacao4: 'nfeInutilizacaoNF' };
  function soap(url, svc, body, ms = 25000, raw, action) {
    if (!action && ACAO[svc]) action = `http://www.portalfiscal.inf.br/nfe/wsdl/${svc}/${ACAO[svc]}`;   // algumas SEFAZ (SP, MG, PR, GO...) exigem
    const env = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body>${raw ? body : `<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/${svc}">${body}</nfeDadosMsg>`}</soap12:Body></soap12:Envelope>`;
    const u = new URL(D.sefazUrl ? D.sefazUrl(url) : url);
    return new Promise((res, rej) => {
      const rq = (u.protocol == 'http:' ? require('http') : https).request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: 'POST', agent: u.protocol == 'http:' ? undefined : agent(), headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' + (action ? `; action="${action}"` : ''), 'Content-Length': Buffer.byteLength(env) } }, r => {
        const ch = []; r.on('data', b => ch.push(b)); r.on('end', () => {
          const t = Buffer.concat(ch).toString('utf8');
          if (r.statusCode >= 500 && !/<cStat>/.test(t)) return rej(new SemRede('SEFAZ respondeu HTTP ' + r.statusCode));
          if (r.statusCode >= 400 && !/<cStat>/.test(t)) return rej(new Error('SEFAZ respondeu HTTP ' + r.statusCode));
          res(t);
        });
      });
      rq.setTimeout(ms, () => rq.destroy(new SemRede('A SEFAZ não respondeu a tempo')));
      rq.on('error', e => rej(e instanceof SemRede ? e : /certificate|PEM|key/i.test(e.message) ? e : new SemRede(e.code || e.message)));
      rq.end(env);
    });
  }
  const tag = (x, t) => { const m = x && x.match(new RegExp(`<(?:\\w+:)?${t}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${t}>`)); return m ? m[1] : '' };
  const ws = () => { const c = cfg(); return UFS[c.uf].ws[c.amb] };

  async function statusServico() {
    const c = cfg();
    const r = await soap(ws().stat, 'NFeStatusServico4', `<consStatServ xmlns="${NS}" versao="4.00"><tpAmb>${c.amb}</tpAmb><cUF>${UFS[c.uf].cUF}</cUF><xServ>STATUS</xServ></consStatServ>`, 15000);
    return { cStat: tag(r, 'cStat'), xMotivo: tag(r, 'xMotivo'), ok: tag(r, 'cStat') == '107', tMed: tag(r, 'tMed') };
  }
  async function consultar(chave) {
    const c = cfg();
    const r = await soap(ws().cons, 'NFeConsultaProtocolo4', `<consSitNFe xmlns="${NS}" versao="4.00"><tpAmb>${c.amb}</tpAmb><xServ>CONSULTAR</xServ><chNFe>${chave}</chNFe></consSitNFe>`, 15000);
    const prot = (r.match(/<protNFe[\s\S]*?<\/protNFe>/) || [])[0] || '';
    return { cStat: tag(r, 'cStat'), xMotivo: tag(r, 'xMotivo'), prot, pStat: tag(prot, 'cStat'), nProt: tag(prot, 'nProt') };
  }
  async function transmitir(xml, ms) {
    const lote = String(Date.now()).slice(-15);
    const r = await soap(ws().aut, 'NFeAutorizacao4', `<enviNFe xmlns="${NS}" versao="4.00"><idLote>${lote}</idLote><indSinc>1</indSinc>${xml}</enviNFe>`, ms);
    const prot = (r.match(/<protNFe[\s\S]*?<\/protNFe>/) || [])[0] || '';
    return { cStat: tag(r, 'cStat'), xMotivo: tag(r, 'xMotivo'), prot, pStat: tag(prot, 'cStat'), pMotivo: tag(prot, 'xMotivo'), nProt: tag(prot, 'nProt'), dhRecbto: tag(prot, 'dhRecbto') };
  }

  /* ---------- registro local ---------- */
  const reg = ch => { const r = db.prepare('select * from nfce where chave=?').get(ch); return r ? { ...r, data: J(r.data) } : null };
  function gravar(chave, venda, serie, num, st, data, xml) {
    db.prepare('insert into nfce(chave,venda,serie,num,st,data,xml,updated_at) values(?,?,?,?,?,?,?,?) on conflict(chave) do update set st=excluded.st, data=excluded.data, xml=coalesce(excluded.xml,nfce.xml), updated_at=excluded.updated_at')
      .run(chave, venda, serie, num, st, JSON.stringify(data), xml, new Date().toISOString());
  }
  function arquivo(chave, xmlProc, sufixo = 'nfce') {
    const d = path.join(XMLD, '20' + chave.slice(2, 4) + '-' + chave.slice(4, 6)); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${chave}-${sufixo}.xml`), '<?xml version="1.0" encoding="UTF-8"?>' + xmlProc);
  }
  const proc = (xml, prot) => `<nfeProc xmlns="${NS}" versao="4.00">${xml}${prot.replace(/ xmlns="[^"]*"/, '')}</nfeProc>`;
  const pendentes = () => db.prepare("select chave from nfce where st='contingencia' order by num").all().map(r => r.chave);
  /* horas desde a emissão da nota em contingência mais antiga (o prazo para transmitir é de 24 h) */
  const pendHoras = () => {
    let t0 = Infinity;
    for (const r of db.prepare("select data from nfce where st='contingencia'").all()) { const d = J(r.data) || {}, t = Date.parse(d.dhEmi || ''); if (t < t0) t0 = t }
    return t0 == Infinity ? 0 : Math.max(0, Math.floor((Date.now() - t0) / 36e5));
  };
  const STOK = ['100', '150'];

  /* ---------- emitir ---------- */
  let fila = Promise.resolve(), ultFalha = 0, ultMsg = '';
  const serial = fn => { const p = fila.then(fn, fn); fila = p.catch(() => { }); return p };
  function emitir(vendaId, venda) {
    return serial(async () => {
      const c = cfg(); if (!c.on) throw new Error('A NFC-e está desligada (Gestão > Fiscal).');
      const ja = db.prepare("select chave from nfce where venda=? and st in ('autorizada','contingencia','cancelada') order by updated_at desc").get(vendaId);
      if (ja) return resumo(reg(ja.chave));
      let v = venda || (one('orders', vendaId) || {}).data; if (!v) throw new Error('Venda não encontrada.');
      if (v.st == 'canc') throw new Error('Venda cancelada.');
      // reaproveita o número de uma tentativa rejeitada desta mesma venda
      const rej = db.prepare("select num, serie from nfce where venda=? and st in ('rejeitada','erro') order by updated_at desc").get(vendaId);
      const reusa = rej && rej.serie == c.serie, num = reusa ? rej.num : c.num;
      const dEmi = new Date();
      try { await ibptGarantir((v.items || []).map(i => { const p = one('products', i.pid); return p && p.data && p.data.ncm })) } catch (e) { }
      v = parteLoja(v);
      if (!v) return { st: 'sem', semNota: true, msg: 'Só produtos de parceiro: a nota é emitida pelo parceiro.', venda: vendaId };
      let m = montar(v, { num, dhEmi: dEmi });   // se faltar NCM etc., para aqui sem gastar o número
      if (!reusa) kvSet('fiscal', { ...cfg(), num: num + 1 });
      const info = x => ({ venda: vendaId, total: x.vNF, trib: x.trib, doc: x.doc, qr: x.qr, dhEmi: x.dhEmi, tpEmis: x.tpEmis, tpAmb: x.tpAmb, op: v.fat && v.fat.op, pags: v.pags, troco: v.troco });
      db.prepare("delete from nfce where venda=? and st in ('rejeitada','erro')").run(vendaId);
      try {
        if (Date.now() - ultFalha < 90000) throw new SemRede('SEFAZ sem comunicação há pouco: ' + ultMsg);
        const r = await transmitir(m.xml, 12000);
        if (r.cStat == '104' && STOK.includes(r.pStat)) {
          const x = proc(m.xml, r.prot); arquivo(m.chave, x);
          gravar(m.chave, vendaId, c.serie, num, 'autorizada', { ...info(m), nProt: r.nProt, dhRecbto: r.dhRecbto, cStat: r.pStat, xMotivo: r.pMotivo }, x);
          log('NFC-e autorizada', c.serie + '/' + num, 'R$', m.vNF.toFixed(2));
        } else if (r.cStat == '104' && ['110', '301', '302', '303'].includes(r.pStat)) {
          gravar(m.chave, vendaId, c.serie, num, 'denegada', { ...info(m), cStat: r.pStat, xMotivo: r.pMotivo }, proc(m.xml, r.prot));
          log('NFC-e DENEGADA', num, r.pStat, r.pMotivo);
        } else {
          const cs = r.cStat == '104' ? r.pStat : r.cStat, xm = r.cStat == '104' ? r.pMotivo : r.xMotivo;
          if (['108', '109'].includes(cs)) throw new SemRede('SEFAZ fora do ar (' + xm + ')');
          gravar(m.chave, vendaId, c.serie, num, 'rejeitada', { ...info(m), cStat: cs, xMotivo: xm }, m.xml);
          log('NFC-e REJEITADA', c.serie + '/' + num, cs, xm);
        }
      } catch (e) {
        if (e instanceof SemRede && !/há pouco/.test(e.message)) { ultFalha = Date.now(); ultMsg = e.message }
        if (!(e instanceof SemRede)) { gravar(m.chave, vendaId, c.serie, num, 'erro', { ...info(m), xMotivo: e.message }, m.xml); log('NFC-e erro', num, e.message); }
        else {
          // contingência offline: mesma numeração, nova chave (tpEmis 9); vai ser enviada depois
          m = montar(v, { num, dhEmi: dEmi, tpEmis: 9, dhCont: new Date(), xJust: 'Sem comunicacao com a SEFAZ: ' + String(e.message).slice(0, 120) });
          gravar(m.chave, vendaId, c.serie, num, 'contingencia', { ...info(m), xMotivo: 'Emitida em contingência (' + e.message + ')' }, m.xml);
          arquivo(m.chave, m.xml, 'nfce-contingencia');
          log('NFC-e em CONTINGÊNCIA', c.serie + '/' + num, e.message);
        }
      }
      return resumo(reg(db.prepare('select chave from nfce where venda=? order by updated_at desc').get(vendaId).chave));
    });
  }
  function resumo(r) {
    if (!r) return null;
    return { chave: r.chave, venda: r.venda, serie: r.serie, num: r.num, st: r.st, ...r.data, xml: undefined };
  }

  /* envia as notas feitas em contingência (chamado de tempos em tempos) */
  let enviando = false;
  function enviarPendentes() { return serial(enviarPend) }
  async function enviarPend() {
    if (enviando || !cfg().on || !pendentes().length) return 0; enviando = true; let n = 0;
    try {
      for (const ch of pendentes()) {
        const r0 = reg(ch); if (!r0) continue;
        let r;
        try { r = await transmitir(r0.xml) } catch (e) { if (e instanceof SemRede) { ultFalha = Date.now(); ultMsg = e.message; break } throw e }
        ultFalha = 0;
        let cs = r.cStat == '104' ? r.pStat : r.cStat, xm = r.cStat == '104' ? r.pMotivo : r.xMotivo, prot = r.prot;
        if (cs == '204') { const q = await consultar(ch); if (STOK.includes(q.pStat)) { cs = q.pStat; prot = q.prot; xm = 'Autorizada (já estava na SEFAZ)' } }
        if (STOK.includes(cs)) {
          const x = proc(r0.xml, prot); arquivo(ch, x);
          gravar(ch, r0.venda, r0.serie, r0.num, 'autorizada', { ...r0.data, nProt: tag(prot, 'nProt'), dhRecbto: tag(prot, 'dhRecbto'), cStat: cs, xMotivo: xm, contingencia: true }, x);
          log('NFC-e de contingência autorizada', r0.num); n++;
        } else if (['108', '109'].includes(cs)) break;
        else {
          gravar(ch, r0.venda, r0.serie, r0.num, cs == '539' ? 'conflito' : 'rejeitada', { ...r0.data, cStat: cs, xMotivo: xm, contingencia: true }, null);
          log('NFC-e de contingência REJEITADA', r0.num, cs, xm);
        }
      }
    } catch (e) { log('NFC-e: erro ao enviar contingência', e.message) }
    finally { enviando = false }
    return n;
  }

  /* ---------- cancelamento (evento 110111) ---------- */
  async function cancelar(chave, just) {
    const r0 = reg(chave); if (!r0) throw new Error('NFC-e não encontrada.');
    if (r0.st != 'autorizada') throw new Error(r0.st == 'contingencia' ? 'Esta NFC-e ainda não foi enviada à SEFAZ. Aguarde a internet voltar e tente de novo.' : 'Só dá para cancelar NFC-e autorizada.');
    just = String(just || '').trim(); if (just.length < 15) throw new Error('Escreva o motivo do cancelamento (mínimo 15 letras).');
    const c = cfg(), dt = dh(), id = `ID110111${chave}01`;
    const inf = `<infEvento Id="${id}"><cOrgao>${UFS[c.uf].cUF}</cOrgao><tpAmb>${c.amb}</tpAmb><CNPJ>${c.cnpj}</CNPJ><chNFe>${chave}</chNFe><dhEvento>${dt}</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Cancelamento</descEvento><nProt>${r0.data.nProt}</nProt><xJust>${txt(just, 255)}</xJust></detEvento></infEvento>`;
    const { sig } = assinar(inf, NS);
    const evento = `<evento xmlns="${NS}" versao="1.00">${inf}${sig}</evento>`;
    const r = await soap(ws().evt, 'NFeRecepcaoEvento4', `<envEvento xmlns="${NS}" versao="1.00"><idLote>${String(Date.now()).slice(-15)}</idLote>${evento}</envEvento>`);
    const ret = (r.match(/<retEvento[\s\S]*?<\/retEvento>/) || [])[0] || '', cs = tag(ret, 'cStat') || tag(r, 'cStat'), xm = tag(ret, 'xMotivo') || tag(r, 'xMotivo');
    if (!['135', '136', '155'].includes(cs)) throw new Error(`SEFAZ não aceitou o cancelamento: ${cs} - ${xm}`);
    const x = `<procEventoNFe xmlns="${NS}" versao="1.00">${evento.replace(` xmlns="${NS}"`, '')}${ret.replace(/ xmlns="[^"]*"/, '')}</procEventoNFe>`;
    arquivo(chave, x, 'canc');
    gravar(chave, r0.venda, r0.serie, r0.num, 'cancelada', { ...r0.data, canc: { dh: dt, just, nProt: tag(ret, 'nProt') } }, null);
    log('NFC-e CANCELADA', r0.num, just); return resumo(reg(chave));
  }

  /* ---------- DANFE NFC-e (lista para a impressora) ---------- */
  function danfe(chave, emp = {}) {
    const r = reg(chave); if (!r) throw new Error('NFC-e não encontrada.');
    const c = cfg(), d = r.data, x = r.xml || '', S = [];
    const br = n => 'R$ ' + (+n || 0).toFixed(2).replace('.', ','), nf = n => String(+n).replace('.', ',');
    const cnpjF = c.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    S.push({ logo: 1 }, { t: c.xNome, a: 'c', b: 1 }, { t: 'CNPJ: ' + cnpjF + '  IE: ' + c.ie, a: 'c' }, { t: `${c.xLgr}, ${c.nro} - ${c.xBairro}, ${c.xMun}/${c.uf}`, a: 'c' }, { hr: 1 },
      { t: 'Documento Auxiliar da Nota Fiscal de Consumidor Eletrônica', a: 'c', b: 1 }, { hr: 1 });
    if (d.tpAmb == 2) S.push({ t: 'EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL', a: 'c', b: 1 }, { hr: 1 });
    const dets = [...x.matchAll(/<det nItem="(\d+)"><prod>([\s\S]*?)<\/prod>/g)];
    S.push({ lr: ['Código Descrição', 'Qtde Un Vl.Unit Vl.Total'] });
    dets.forEach(([, n, p]) => {
      const nome = d.tpAmb == 2 && n == '1' ? ((one('orders', r.venda) || {}).data || { items: [] }).items[0]?.n || tag(p, 'xProd') : tag(p, 'xProd');
      S.push({ t: `${tag(p, 'cProd')} ${nome.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')}` }, { lr: [`  ${nf(+tag(p, 'qCom'))} ${tag(p, 'uCom')} x ${(+tag(p, 'vUnCom')).toFixed(2).replace('.', ',')}`, br(tag(p, 'vProd'))] });
    });
    const tot = tag(x, 'ICMSTot');
    S.push({ hr: 1 }, { lr: ['Qtde. total de itens', String(dets.length)] }, { lr: ['Valor total R$', br(tag(tot, 'vProd'))] });
    if (+tag(tot, 'vDesc')) S.push({ lr: ['Desconto R$', br(tag(tot, 'vDesc'))] });
    if (+tag(tot, 'vOutro')) S.push({ lr: ['Acréscimos R$', br(tag(tot, 'vOutro'))] });
    S.push({ lr: ['Valor a pagar R$', br(tag(tot, 'vNF'))], b: 1 }, { lr: ['FORMA PAGAMENTO', 'VALOR PAGO R$'] });
    const NOME = { '01': 'Dinheiro', '03': 'Cartão de Crédito', '04': 'Cartão de Débito', '05': 'Crédito Loja', '17': 'Pix', '99': 'Outros' };
    [...x.matchAll(/<detPag>([\s\S]*?)<\/detPag>/g)].forEach(([, p]) => S.push({ lr: [NOME[tag(p, 'tPag')] || tag(p, 'xPag') || 'Outros', br(tag(p, 'vPag'))] }));
    if (+tag(x, 'vTroco')) S.push({ lr: ['Troco R$', br(tag(x, 'vTroco'))] });
    if (d.trib && d.trib.tot > 0) S.push({ hr: 1 }, { t: 'Tributos totais incidentes (Lei Federal 12.741/2012): ' + br(d.trib.tot), a: 'c' }, { t: `Federal ${br(d.trib.fed)} · Estadual ${br(d.trib.est)} · Municipal ${br(d.trib.mun)}`, a: 'c' }, { t: 'Fonte: ' + (d.trib.fonte || 'IBPT') + ' ' + (d.trib.chave || ''), a: 'c' });
    S.push({ hr: 1 }, { t: 'Consulte pela Chave de Acesso em', a: 'c', b: 1 }, { t: (UFS[c.uf] || { urlChave: {} }).urlChave[c.amb] || '', a: 'c' }, { t: chave.replace(/(\d{4})/g, '$1 ').trim(), a: 'c' }, { hr: 1 });
    S.push({ t: d.doc ? 'CONSUMIDOR - ' + (d.doc.length == 11 ? 'CPF ' + d.doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : 'CNPJ ' + d.doc) : 'CONSUMIDOR NÃO IDENTIFICADO', a: 'c', b: 1 });
    const de = new Date(d.dhEmi);
    S.push({ t: `NFC-e nº ${String(r.num).padStart(9, '0')}  Série ${String(r.serie).padStart(3, '0')}  ${de.toLocaleDateString('pt-BR')} ${de.toLocaleTimeString('pt-BR')}`, a: 'c', b: 1 });
    if (r.st == 'contingencia' || (d.tpEmis == 9 && !d.nProt)) S.push({ box: 'EMITIDA EM CONTINGÊNCIA' }, { t: 'Pendente de autorização', a: 'c', b: 1 });
    else if (d.nProt) S.push({ t: 'Protocolo de autorização: ' + d.nProt, a: 'c' }, { t: 'Data de autorização: ' + new Date(d.dhRecbto).toLocaleString('pt-BR'), a: 'c' });
    if (r.st == 'cancelada') S.push({ box: 'NFC-e CANCELADA' });
    if (d.tpAmb == 2) S.push({ t: 'EMITIDA EM AMBIENTE DE HOMOLOGAÇÃO - SEM VALOR FISCAL', a: 'c', b: 1 });
    S.push({ qr: d.qr });
    if (d.op) S.push({ t: 'Operador: ' + d.op, a: 'c' });
    S.push(...parteParceiros(d.venda));
    S.push({ t: 'Sistema AdaptaSys Mercado', a: 'c' });
    String(emp.msg || '').split('\n').forEach(l => l.trim() && S.push({ t: l, a: 'c' }));
    return S;
  }
  /* bloco "sem valor fiscal" com os produtos dos parceiros, logo abaixo da NFC-e, e o total do pedido */
  function parteParceiros(vendaId) {
    const v = vendaId && (one('orders', vendaId) || {}).data; if (!v) return [];
    const br = n => 'R$ ' + (+n || 0).toFixed(2).replace('.', ','), nf = q => String(+(+q).toFixed(3)).replace('.', ',');
    const pi = (v.items || []).filter(i => +i.q > 0 && ehParc(i)); if (!pi.length) return [];
    const grupos = {}; for (const i of pi) { const p = (one('products', i.pid) || {}).data || {}, k = i.parc || p.parc; (grupos[k] = grupos[k] || { nome: (v.parts && v.parts[k] && v.parts[k].nome) || p.parcN || 'Parceiro', itens: [] }).itens.push(i) }
    const S = [];
    for (const [k, g] of Object.entries(grupos)) {
      const pt = (v.parts && v.parts[k]) || {}, tot = g.itens.reduce((s, i) => s + r2(+i.t || (+i.q * +i.p)), 0);
      S.push({ hr: 1 }, { box: 'PRODUTOS DO PARCEIRO - SEM VALOR FISCAL' }, { t: g.nome + (pt.cnpj ? ' · CNPJ ' + pt.cnpj : ''), a: 'c', b: 1 });
      g.itens.forEach(i => S.push({ t: i.n }, { lr: [`  ${nf(i.q)} ${i.u || 'un'} x ${(+i.p).toFixed(2).replace('.', ',')}`, br(r2(+i.t || (+i.q * +i.p)))] }));
      S.push({ lr: ['Total parceiro', br(tot)], b: 1 }, { t: 'A nota destes itens é emitida pelo parceiro' + (pt.nota ? ' (nº ' + pt.nota + ')' : '') + '.', a: 'c' });
    }
    const pg = (v.pags || []).filter(g => +g.v > 0);
    S.push({ hr: 1 }, { lr: ['TOTAL DO PEDIDO', br(v.total)], b: 1 });
    if (+v.taxa) S.push({ lr: ['(inclui taxa de entrega)', br(v.taxa)] });
    pg.forEach(g => S.push({ lr: ['Pago: ' + g.f, br(g.f == 'Dinheiro' && +g.r ? g.r : g.v)] }));
    if (+v.troco) S.push({ lr: ['Troco', br(v.troco)] });
    return S;
  }

  /* ---------- listas e arquivos ---------- */
  function lista(q = {}) {
    const de = q.de || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), ate = q.ate || new Date().toISOString().slice(0, 10);
    return db.prepare("select chave,venda,serie,num,st,data,updated_at from nfce where substr(json_extract(data,'$.dhEmi'),1,10) between ? and ? order by serie, num desc limit 2000").all(de, ate)
      .map(r => { const d = J(r.data) || {}; return { chave: r.chave, venda: r.venda, serie: r.serie, num: r.num, st: r.st, total: d.total, dhEmi: d.dhEmi, cStat: d.cStat, xMotivo: d.xMotivo, nProt: d.nProt, doc: d.doc, tpAmb: d.tpAmb, contingencia: d.tpEmis == 9 } });
  }
  const daVenda = id => { const r = db.prepare("select chave from nfce where venda=? order by case st when 'autorizada' then 0 when 'contingencia' then 1 when 'cancelada' then 2 else 3 end, updated_at desc").get(id); return r ? resumo(reg(r.chave)) : null };
  function xmlDe(chave) { const r = reg(chave); if (!r || !r.xml) { const x55 = typeof xml55 == 'function' ? xml55(chave) : null; if (x55) return x55; throw new Error('XML não encontrado.') } return '<?xml version="1.0" encoding="UTF-8"?>' + r.xml }
  /* zip dos XMLs do mês (para o contador) — zip simples, sem dependências */
  function zipMes(mes) {
    if (!/^\d{4}-\d{2}$/.test(mes)) throw new Error('Mês inválido.');
    const d = path.join(XMLD, mes); const fsx = fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.xml')) : [];
    const T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++)c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c });
    const crc = b => { let c = -1; for (const x of b) c = T[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0 };
    const loc = [], cen = []; let off = 0;
    for (const f of fsx) {
      const data = fs.readFileSync(path.join(d, f)), z = zlib.deflateRawSync(data), nm = Buffer.from(f), cr = crc(data);
      const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(cr, 14); h.writeUInt32LE(z.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26);
      const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(cr, 16); c.writeUInt32LE(z.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
      loc.push(h, nm, z); cen.push(c, nm); off += 30 + nm.length + z.length;
    }
    const cd = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(fsx.length, 8); e.writeUInt16LE(fsx.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
    return { buf: Buffer.concat([...loc, cd, e]), n: fsx.length };
  }
  function resumoDia() {
    const hoje = new Date().toISOString().slice(0, 10);
    const r = db.prepare("select st, count(*) n from nfce where substr(json_extract(data,'$.dhEmi'),1,10)=? group by st").all(hoje);
    return Object.fromEntries(r.map(x => [x.st, x.n]));
  }

  /* ================= NF-e recebidas (Distribuição DF-e do Ambiente Nacional) =================
     Busca as NF-e que fornecedores emitem para o CNPJ da loja. Regras da SEFAZ: consultar pelo
     último NSU; quando não houver mais documentos (137) ou chegar ao maxNSU, esperar 1 hora.
     A nota chega primeiro como resumo; com a "Ciência da Operação" (210210) a SEFAZ libera o XML. */
  db.exec(`create table if not exists nfe_dest(chave text primary key, nsu text, emit text, nome text, valor real, dh text, st text, manif text, xml text, data text, updated_at text);`);
  const AN = {
    1: { dist: 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx', evt: 'https://www.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx' },
    2: { dist: 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx', evt: 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx' }
  };
  const AMB_DIST = 1;   // notas de fornecedor são sempre de produção (a consulta só lê; não depende da NFC-e estar em teste)
  const dst = () => ({ ult: '000000000000000', prox: 0, last: 0, err: '', ...(kvGet('dist') || {}) });
  const unz = b64 => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8');
  async function distReq(inner) {
    const c = cfg();
    const body = `<nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg><distDFeInt xmlns="${NS}" versao="1.01"><tpAmb>${AMB_DIST}</tpAmb><cUFAutor>${UFS[c.uf].cUF}</cUFAutor><CNPJ>${c.cnpj}</CNPJ>${inner}</distDFeInt></nfeDadosMsg></nfeDistDFeInteresse>`;
    const r = await soap(AN[AMB_DIST].dist, null, body, 30000, true, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse');
    const docs = [...r.matchAll(/<docZip NSU="(\d+)" schema="([^"]+)"[^>]*>([^<]+)<\/docZip>/g)].map(m => ({ nsu: m[1], schema: m[2], xml: unz(m[3]) }));
    return { cStat: tag(r, 'cStat'), xMotivo: tag(r, 'xMotivo'), ult: tag(r, 'ultNSU'), max: tag(r, 'maxNSU'), docs };
  }
  const upDest = db.prepare(`insert into nfe_dest(chave,nsu,emit,nome,valor,dh,st,manif,xml,data,updated_at) values(@chave,@nsu,@emit,@nome,@valor,@dh,@st,@manif,@xml,@data,@u)
    on conflict(chave) do update set nsu=coalesce(excluded.nsu,nfe_dest.nsu), emit=coalesce(excluded.emit,nfe_dest.emit), nome=coalesce(excluded.nome,nfe_dest.nome), valor=coalesce(excluded.valor,nfe_dest.valor), dh=coalesce(excluded.dh,nfe_dest.dh),
    st=case when nfe_dest.st='cancelada' then 'cancelada' when nfe_dest.st='completa' and excluded.st='resumo' then 'completa' else coalesce(excluded.st,nfe_dest.st) end,
    manif=coalesce(excluded.manif,nfe_dest.manif), xml=coalesce(excluded.xml,nfe_dest.xml), data=coalesce(excluded.data,nfe_dest.data), updated_at=excluded.updated_at`);
  const destDe = ch => db.prepare('select * from nfe_dest where chave=?').get(ch);
  function guardarDoc(d) {
    const c = cfg(), x = d.xml, u = new Date().toISOString(), base = { nsu: d.nsu, emit: null, nome: null, valor: null, dh: null, st: null, manif: null, xml: null, data: null, u };
    if (/^resNFe/.test(d.schema)) {
      const ch = tag(x, 'chNFe'); if (!ch || tag(x, 'CNPJ') == c.cnpj) return;
      upDest.run({ ...base, chave: ch, emit: tag(x, 'CNPJ') || tag(x, 'CPF'), nome: tag(x, 'xNome'), valor: +tag(x, 'vNF') || 0, dh: tag(x, 'dhEmi'), st: tag(x, 'cSitNFe') == '3' ? 'cancelada' : tag(x, 'cSitNFe') == '2' ? 'denegada' : 'resumo' });
    } else if (/^procNFe/.test(d.schema)) {
      const ch = (x.match(/Id="NFe(\d{44})"/) || [])[1], em = tag(x, 'emit'); if (!ch || tag(em, 'CNPJ') == c.cnpj) return;
      upDest.run({ ...base, chave: ch, emit: tag(em, 'CNPJ') || tag(em, 'CPF'), nome: tag(em, 'xNome'), valor: +tag(tag(x, 'ICMSTot'), 'vNF') || 0, dh: tag(x, 'dhEmi'), st: 'completa', xml: x });
      try { const dd = path.join(XMLD, 'recebidas', '20' + ch.slice(2, 4) + '-' + ch.slice(4, 6)); fs.mkdirSync(dd, { recursive: true }); fs.writeFileSync(path.join(dd, ch + '-nfe.xml'), x.startsWith('<?xml') ? x : '<?xml version="1.0" encoding="UTF-8"?>' + x) } catch (e) { }
    } else if (/^(resEvento|procEventoNFe)/.test(d.schema)) {
      const ch = tag(x, 'chNFe'), tp = tag(x, 'tpEvento'); if (!ch || !destDe(ch)) return;
      if (tp == '110111' || tp == '110112') db.prepare("update nfe_dest set st='cancelada', updated_at=? where chave=?").run(u, ch);
    }
  }
  /* Ciência da Operação (210210) no Ambiente Nacional, até 20 notas por lote */
  async function ciencia(chaves) {
    const c = cfg(); if (!chaves.length) return {};
    const evs = chaves.slice(0, 20).map(ch => {
      const inf = `<infEvento Id="ID210210${ch}01"><cOrgao>91</cOrgao><tpAmb>${AMB_DIST}</tpAmb><CNPJ>${c.cnpj}</CNPJ><chNFe>${ch}</chNFe><dhEvento>${dh()}</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>1</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento>`;
      return `<evento xmlns="${NS}" versao="1.00">${inf}${assinar(inf, NS).sig}</evento>`;
    }).join('');
    const r = await soap(AN[AMB_DIST].evt, 'NFeRecepcaoEvento4', `<envEvento xmlns="${NS}" versao="1.00"><idLote>${String(Date.now()).slice(-15)}</idLote>${evs}</envEvento>`);
    const out = {};
    for (const m of r.matchAll(/<retEvento[\s\S]*?<\/retEvento>/g)) {
      const ch = tag(m[0], 'chNFe'), cs = tag(m[0], 'cStat'); out[ch] = cs;
      // 135/136 = registrado; 573 = a ciência já existia
      if (['135', '136', '573'].includes(cs)) db.prepare('update nfe_dest set manif=?, updated_at=? where chave=?').run('ciencia:' + Date.now(), new Date().toISOString(), ch);
      else log('NF-e recebida: ciência recusada', ch.slice(25, 34), cs, tag(m[0], 'xMotivo'));
    }
    return out;
  }
  /* baixa o XML completo pela chave (depois da ciência) */
  async function baixarXml(ch) {
    const r = await distReq(`<consChNFe><chNFe>${ch}</chNFe></consChNFe>`);
    tx(() => r.docs.forEach(guardarDoc));
    const d = destDe(ch); return { cStat: r.cStat, xMotivo: r.xMotivo, ok: !!(d && d.xml) };
  }
  let distRodando = false;
  async function distBuscar(forcar) {
    const c = cfg(), S = dst();
    if (!c.distOn && !forcar) return { pulado: 'desligada' };
    if (!c.cnpj || !fs.existsSync(CERTF)) throw new Error('Instale o certificado e informe o CNPJ em Gestão > Fiscal.');
    if (Date.now() < S.prox) return { espera: S.prox, msg: 'A SEFAZ só deixa consultar de novo às ' + new Date(S.prox).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '.' };
    if (distRodando) return { msg: 'Busca em andamento.' };
    distRodando = true; let novos = 0, err = '';
    const conta = () => db.prepare('select count(*) n from nfe_dest').get().n;
    try {
      for (let i = 0; i < 25; i++) {
        const r = await distReq(`<distNSU><ultNSU>${S.ult}</ultNSU></distNSU>`);
        if (r.cStat == '138') {
          const antes = conta(); tx(() => r.docs.forEach(guardarDoc)); novos += conta() - antes;
          S.ult = r.ult || S.ult; kvSet('dist', S);
          if (!r.max || S.ult >= r.max) { S.prox = Date.now() + 3660e3; break }
        } else if (r.cStat == '137') { S.ult = r.ult || S.ult; S.prox = Date.now() + 3660e3; break }
        else { err = r.cStat + ' - ' + r.xMotivo; S.prox = Date.now() + 3660e3; log('NF-e recebidas: SEFAZ respondeu', err); break }
      }
    } catch (e) { err = e.message; S.prox = Date.now() + 15 * 60e3; log('NF-e recebidas: erro', e.message) }
    finally { distRodando = false; S.last = Date.now(); S.err = err; kvSet('dist', S) }
    // ciência automática nas que chegaram só como resumo; depois baixa o XML das que já têm ciência
    try {
      if (c.distCiencia) {
        const sem = db.prepare("select chave from nfe_dest where st='resumo' and manif is null order by dh desc limit 20").all().map(r => r.chave);
        if (sem.length) await ciencia(sem);
      }
      for (const r of db.prepare("select chave, manif from nfe_dest where st='resumo' and manif like 'ciencia:%' order by dh desc limit 10").all()) {
        if (!forcar && Date.now() - +r.manif.split(':')[1] < 60e3) continue;
        await baixarXml(r.chave);
      }
    } catch (e) { log('NF-e recebidas: ciência/download', e.message) }
    if (novos) log('NF-e recebidas: ' + novos + ' nova(s)');
    return { novos, err, prox: S.prox };
  }
  function distLista(q = {}) {
    const dias = Math.max(1, Math.min(365, +q.dias || 60)), de = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10);
    const imp = db.prepare("select 1 from mov_estoque where json_extract(data,'$.chave')=? limit 1");
    return db.prepare('select chave,emit,nome,valor,dh,st,manif,(xml is not null) temXml from nfe_dest where substr(coalesce(dh,updated_at),1,10)>=? order by dh desc limit 500').all(de)
      .map(r => ({ ...r, temXml: !!r.temXml, importada: !!imp.get(r.chave), num: +r.chave.slice(25, 34), serie: +r.chave.slice(22, 25) }));
  }
  function distXml(ch) { const r = destDe(ch); if (!r || !r.xml) throw new Error('O XML desta nota ainda não chegou. Toque em "Pedir XML".'); return r.xml }
  async function distPedir(ch) {
    const r = destDe(ch); if (!r) throw new Error('Nota não encontrada.');
    if (r.xml) return { ok: true };
    if (!r.manif) { const c = await ciencia([ch]); if (!['135', '136', '573'].includes(c[ch])) throw new Error('A SEFAZ não aceitou a ciência da nota (' + (c[ch] || 'sem resposta') + ').') }
    const b = await baixarXml(ch);
    return b.ok ? { ok: true } : { ok: false, msg: 'Ciência registrada. A SEFAZ costuma liberar o XML em alguns minutos; a busca automática traz sozinho.' };
  }
  function distEstado() {
    const S = dst(), c = cfg();
    const prontas = db.prepare("select count(*) n from nfe_dest d where d.xml is not null and d.st<>'cancelada' and not exists (select 1 from mov_estoque m where json_extract(m.data,'$.chave')=d.chave)").get().n;
    return { on: !!c.distOn, ciencia: !!c.distCiencia, last: S.last, prox: S.prox, err: S.err, prontas };
  }


  /* ================= Tabela IBPT (Lei 12.741/2012 — "De Olho no Imposto") =================
     Valor aproximado dos tributos por NCM. A tabela NÃO vem mais dentro do programa: o sistema baixa
     sozinho a da UF da loja, atualiza sozinha quando sai versão nova (cópia aberta das tabelas oficiais no GitHub) e
     também aceita o arquivo oficial baixado em deolhonoimposto.ibpt.org.br (.csv ou .zip). */
  db.exec(`create table if not exists ibpt(ncm text not null, ex text not null default '', fn real, fi real, est real, mun real, primary key(ncm, ex));`);
  const IBPT_REPO = process.env.IBPT_REPO || 'https://api.github.com/repos/luizinhoh2o1/tabelas-ibpt/contents/repositorio-ibpt';
  const ibptMeta = () => kvGet('ibpt') || null;
  const dBr = s => { const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : '' };
  const verN = v => { const m = String(v || '').match(/^(\d+)\.(\d+)\.([A-Z])$/); return m ? (+m[1]) * 10000 + (+m[2]) * 100 + (m[3].charCodeAt(0) - 64) : 0 };
  function ibptGravar(meta, linhas, origem) {
    if (linhas.length < 3000) throw new Error('Tabela IBPT incompleta (' + linhas.length + ' NCMs).');
    if (!verN(meta.versao)) throw new Error('Versão da tabela IBPT não reconhecida: ' + meta.versao);
    const ok = n => typeof n == 'number' && n >= 0 && n <= 100;
    tx(() => {
      db.exec('delete from ibpt');
      const ins = db.prepare('insert or replace into ibpt(ncm,ex,fn,fi,est,mun) values(?,?,?,?,?,?)');
      for (const [ncm, ex, fn, fi, est, mun] of linhas) if (/^\d{8}$/.test(ncm) && [fn, fi, est, mun].every(ok)) ins.run(ncm, ex || '', fn, fi, est, mun);
      kvSet('ibpt', { versao: meta.versao, ini: meta.ini, fim: meta.fim, chave: meta.chave, fonte: meta.fonte || 'IBPT', uf: meta.uf, n: linhas.length, em: new Date().toISOString(), origem });
    });
    log('IBPT: tabela', meta.versao, meta.uf, 'válida até', meta.fim, '·', linhas.length, 'NCMs ·', origem);
    return ibptMeta();
  }
  /* CSV oficial: codigo;ex;tipo;descricao;nacionalfederal;importadosfederal;estadual;municipal;vigenciainicio;vigenciafim;chave;versao;fonte */
  function ibptCsv(txt, uf) {
    const L = txt.split(/\r?\n/), h = (L[0] || '').toLowerCase().split(';');
    const ix = k => h.indexOf(k); if (ix('codigo') < 0 || ix('nacionalfederal') < 0) throw new Error('Este arquivo não é uma tabela do IBPT.');
    const linhas = []; let meta = null;
    for (let i = 1; i < L.length; i++) {
      const c = L[i].match(/("([^"]|"")*"|[^;]*)(;|$)/g); if (!c || c.length < 13) continue;
      const v = c.map(x => x.replace(/;$/, '').replace(/^"|"$/g, ''));
      if (v[ix('tipo')] != '0') continue;
      const num = k => parseFloat(String(v[ix(k)]).replace(',', '.'));
      linhas.push([v[ix('codigo')], v[ix('ex')], num('nacionalfederal'), num('importadosfederal'), num('estadual'), num('municipal')]);
      if (!meta) meta = { versao: v[ix('versao')], ini: v[ix('vigenciainicio')], fim: v[ix('vigenciafim')], chave: v[ix('chave')], fonte: v[ix('fonte')], uf };
    }
    if (!meta) throw new Error('Tabela IBPT vazia.');
    return { meta, linhas };
  }
  /* lê um arquivo de dentro de um .zip (sem bibliotecas) */
  function unzipAcha(buf, teste) {
    let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) != 0x06054b50) e--;
    if (e < 0) throw new Error('Arquivo .zip inválido.');
    let p = buf.readUInt32LE(e + 16); const n = buf.readUInt16LE(e + 10);
    for (let i = 0; i < n; i++) {
      const met = buf.readUInt16LE(p + 10), csz = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
      const nome = buf.slice(p + 46, p + 46 + nl).toString('latin1');
      if (teste(nome)) {
        const ln = buf.readUInt16LE(off + 26), lx = buf.readUInt16LE(off + 28), d = buf.slice(off + 30 + ln + lx, off + 30 + ln + lx + csz);
        return { nome, data: met == 8 ? zlib.inflateRawSync(d) : d };
      }
      p += 46 + nl + xl + cl;
    }
    return null;
  }
  function ibptImportar(b) {
    const uf = cfg().uf || '', buf = Buffer.from(String(b.b64 || '').replace(/^data:[^,]*,/, ''), 'base64');
    let txt;
    if (buf.readUInt32LE(0) == 0x04034b50) {
      const f = unzipAcha(buf, n => new RegExp(`TabelaIBPTax${uf}[^/]*\\.csv$`, 'i').test(n));
      if (!f) throw new Error(`O .zip não tem a tabela do ${uf}.`);
      txt = f.data.toString('latin1');
    } else txt = buf.toString(/[À-ÿ]/.test(buf.toString('utf8')) ? 'utf8' : 'latin1');
    const t = ibptCsv(txt, uf);
    return ibptGravar(t.meta, t.linhas, 'arquivo ' + String(b.nome || '').slice(0, 60));
  }
  /* tabela antiga embutida (ibpt\UF.json.gz): só usa se o arquivo ainda existir na pasta */
  function ibptEmbutida() {
    const uf = cfg().uf || ''; if (!uf) return null;
    const f = path.join(__dirname, 'ibpt', uf + '.json.gz'); if (!fs.existsSync(f)) return null;
    const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
    const m = ibptMeta(); if (m && m.uf == uf && verN(m.versao) >= verN(j.versao)) return m;
    return ibptGravar(j, j.dados, 'tabela que veio com o sistema');
  }
  /* exporta a tabela instalada (+ o que a API já respondeu e a tabela não tem) no formato oficial do IBPT,
     para importar em outro computador pelo campo "Importar arquivo" */
  function ibptExportar() {
    const m = ibptMeta(), uf = cfg().uf || (m && m.uf) || '';
    const rows = db.prepare('select * from ibpt order by ncm, ex').all();
    const tem = new Set(rows.map(r => r.ncm + '|' + r.ex));
    const api = uf ? db.prepare('select * from ibpt_api where uf=? order by ncm, ex').all(uf).filter(r => !tem.has(r.ncm + '|' + r.ex)) : [];
    if (!rows.length && !api.length) throw new Error('Nenhuma tabela IBPT instalada para exportar.');
    const n = x => (+x || 0).toFixed(2).replace('.', ',');
    const L = ['codigo;ex;tipo;descricao;nacionalfederal;importadosfederal;estadual;municipal;vigenciainicio;vigenciafim;chave;versao;fonte'];
    for (const r of rows) L.push([r.ncm, r.ex, 0, '', n(r.fn), n(r.fi), n(r.est), n(r.mun), m && m.ini || '', m && m.fim || '', m && m.chave || '', m && m.versao || '', m && m.fonte || 'IBPT'].join(';'));
    for (const r of api) L.push([r.ncm, r.ex, 0, '', n(r.fn), n(r.fi), n(r.est), n(r.mun), m && m.ini || '', r.fim || (m && m.fim) || '', r.chave || '', r.versao || (m && m.versao) || '', r.fonte || 'IBPT (API)'].join(';'));
    const ver = String(m && m.versao || 'api').replace(/[^0-9A-Za-z.]/g, '');
    return { nome: `TabelaIBPTax${uf}${ver}.csv`, buf: Buffer.from(L.join('\r\n') + '\r\n', 'latin1'), n: L.length - 1 };
  }
  /* atualização automática: procura versão mais nova que a instalada */
  let ibptBusy = false;
  async function ibptAtualizar(forcar) {
    if (ibptBusy) return { msg: 'Atualização em andamento.' };
    if (!cfg().uf) return { pulado: true, msg: 'Informe o estado (UF) nos ajustes fiscais.' };
    const m0 = ibptMeta(), m = m0 && m0.uf == cfg().uf ? m0 : null, hoje = new Date().toISOString().slice(0, 10), ult = kvGet('ibptCheck') || 0;
    const vencendo = !m || !m.fim || dBr(m.fim) <= new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
    if (!forcar && Date.now() - ult < (!m ? 0.5 : vencendo ? 3 : 24) * 3600e3) return { pulado: true };
    ibptBusy = true; kvSet('ibptCheck', Date.now());
    try {
      const h = { 'User-Agent': 'AdaptaSys-Mercado-PDV', Accept: 'application/vnd.github+json' };
      const r = await fetch(IBPT_REPO, { headers: h, signal: AbortSignal.timeout(20000) }); if (!r.ok) throw new Error('GitHub respondeu ' + r.status);
      const l = (await r.json()).map(x => ({ v: (x.name.match(/TabelaIBPTax_(\d+\.\d+\.[A-Z])\.zip$/) || [])[1], url: x.download_url })).filter(x => x.v).sort((a, b) => verN(b.v) - verN(a.v));
      const novo = l[0]; if (!novo) throw new Error('Nenhuma tabela encontrada.');
      if (m && verN(m.versao) >= verN(novo.v)) return { atual: true, versao: m.versao, msg: 'A tabela ' + m.versao + ' já é a mais nova.' + (dBr(m.fim) < hoje ? ' (O IBPT ainda não publicou a próxima.)' : '') };
      const z = await fetch(novo.url, { headers: { 'User-Agent': 'AdaptaSys-Mercado-PDV' }, signal: AbortSignal.timeout(120000) }); if (!z.ok) throw new Error('Download respondeu ' + z.status);
      const buf = Buffer.from(await z.arrayBuffer()), uf = cfg().uf || '';
      const f = unzipAcha(buf, n => new RegExp(`TabelaIBPTax${uf}[^/]*\\.csv$`, 'i').test(n)); if (!f) throw new Error('Tabela do ' + uf + ' não encontrada no arquivo.');
      const t = ibptCsv(f.data.toString('latin1'), uf);
      return { novo: true, ...ibptGravar(t.meta, t.linhas, 'atualização automática') };
    } catch (e) { log('IBPT: não foi possível atualizar:', e.message); if (forcar) throw new Error('Não foi possível atualizar agora (' + e.message + '). Você pode importar o arquivo oficial.'); return { erro: e.message } }
    finally { ibptBusy = false }
  }
  try { ibptEmbutida() } catch (e) { log('IBPT: tabela embutida', e.message) }
  setTimeout(() => ibptAtualizar().catch(() => { }), ibptMeta() ? 60e3 : 8e3);
  setInterval(() => ibptAtualizar().catch(() => { }), 30 * 60e3);
  const qIb = db.prepare('select * from ibpt where ncm=? and ex=?');
  /* ===== IBPT pela API (apidoni.ibpt.org.br), conjugada com a tabela =====
     Modos (Configurações › Fiscal): auto = tabela primeiro e a API para o que faltar ou quando a tabela vencer (padrão);
     api = API primeiro e a tabela se a API não tiver; tabela = só a tabela; off = a nota não informa tributos.
     A resposta da API fica guardada aqui (ibpt_api) até o fim da vigência: a venda nunca espera a internet por isso.
     O IBPT recusa servidores na nuvem, mas atende o computador da loja: por isso a consulta é feita por este servidor local.
     O token fica só neste computador e nunca aparece em log ou mensagem de erro. */
  db.exec(`create table if not exists ibpt_api(uf text not null, ncm text not null, ex text not null default '', fn real, fi real, est real, mun real, chave text, versao text, fonte text, fim text, em text, primary key(uf, ncm, ex));`);
  const qIa = db.prepare('select * from ibpt_api where uf=? and ncm=? and ex=?');
  const IBPT_API = process.env.IBPT_API || 'https://apidoni.ibpt.org.br/api/v1/produtos';
  const ibModo = () => { const m = cfg().ibptModo; return ['auto', 'api', 'tabela', 'off'].includes(m) ? m : 'auto' };
  const hojeIso = () => new Date().toISOString().slice(0, 10);
  const tabVencida = () => { const m = ibptMeta(); return !m || !!(dBr(m.fim) && dBr(m.fim) < hojeIso()) };
  const apiValida = r => !!r && (dBr(r.fim) ? dBr(r.fim) >= hojeIso() : Date.parse(r.em) > Date.now() - 30 * 864e5);
  let ibCaiu = 0, ibErro = '', ibOk = '';
  const tiraToken = (t, tk) => String(t || '').split(tk || '\u0000').join('***').replace(/token=[^&\s)]+/gi, 'token=***').replace(/https?:\/\/[^\s)]+/gi, '(endereço do IBPT)');
  function ibGet(url, ms) {   // HTTP/1.1 direto; o IBPT fecha a conexão sem aviso: vale a resposta que já chegou
    return new Promise((ok, no) => {
      const u = new URL(url); let st = 0, txt = '', fim = false; const done = (e) => { if (fim) return; fim = true; clearTimeout(t); if (st) ok({ status: st, text: txt }); else no(e || new Error('sem resposta')) };
      const rq = (u.protocol == 'http:' ? require('http') : https).request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', ALPNProtocols: ['http/1.1'],
        headers: { Accept: 'application/json, text/plain, */*', 'Accept-Language': 'pt-BR,pt;q=0.9', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AdaptaSysMercado', Connection: 'close' } }, res => {
        st = res.statusCode; res.setEncoding('utf8'); res.on('data', d => { txt += d; if (txt.length > 200000) rq.destroy() }); res.on('end', () => done()); res.on('error', e => done(e)); res.on('aborted', () => done());
      });
      const t = setTimeout(() => { rq.destroy(new Error('tempo esgotado')) }, ms || 10000);
      rq.on('error', e => done(e)); rq.end();
    });
  }
  function ibLer(txt, tk) {
    let k = null;
    try { let j = JSON.parse(txt); if (Array.isArray(j)) j = j[0]; if (j && typeof j == 'object') k = Object.fromEntries(Object.entries(j).map(([a, b]) => [a.toLowerCase(), b])) } catch (e) { }
    if (!k) { const g = n => { const m = String(txt).match(new RegExp('<' + n + '>\\s*([^<]*?)\\s*</' + n + '>', 'i')); return m ? m[1] : undefined }; if (g('Nacional') !== undefined || g('Estadual') !== undefined) k = { nacional: g('Nacional'), importado: g('Importado'), estadual: g('Estadual'), municipal: g('Municipal'), chave: g('Chave'), versao: g('Versao'), fonte: g('Fonte'), vigenciafim: g('VigenciaFim') }; else { const m = String(txt).match(/<Message>\s*([^<]*?)\s*<\/Message>/i); throw new Error('IBPT: ' + tiraToken(m ? m[1] : String(txt).replace(/<[^>]*>/g, ' ').trim().slice(0, 200), tk)) } }
    if (k.nacional === undefined && k.estadual === undefined) throw new Error('IBPT: ' + tiraToken(String(k.message || k.mensagem || k.erro || 'resposta sem percentuais'), tk).slice(0, 200));
    const n = x => { const v = parseFloat(String(x ?? '').replace(',', '.')); return isFinite(v) ? v : 0 };
    return { fn: n(k.nacional), fi: n(k.importado), est: n(k.estadual), mun: n(k.municipal), chave: String(k.chave || ''), versao: String(k.versao || ''), fonte: String(k.fonte || 'IBPT'), fim: String(k.vigenciafim || '') };
  }
  async function ibptApi(ncm, ex, forcar, desc, un, valor) {
    const c = cfg(), tk = String(c.ibptToken || '').trim(); ncm = dg(ncm); ex = String(ex || '');
    if (ncm.length != 8) throw new Error('NCM inválido (precisa de 8 dígitos).');
    if (!tk) throw new Error('Token do IBPT não cadastrado (Configurações › Fiscal).');
    if (dg(c.cnpj).length != 14) throw new Error('CNPJ da empresa não cadastrado (Configurações › Fiscal).');
    if (!c.uf) throw new Error('Estado (UF) não cadastrado (Configurações › Fiscal).');
    const cache = qIa.get(c.uf, ncm, ex); if (!forcar && apiValida(cache)) return cache;
    if (!forcar && Date.now() - ibCaiu < 600e3) throw new Error('IBPT fora do ar há poucos minutos; usando a tabela.');
    const q = new URLSearchParams({ token: tk, cnpj: dg(c.cnpj), codigo: ncm, uf: c.uf, ex: ex || '0', descricao: String(desc || 'Produto').slice(0, 120), unidadeMedida: un || 'UN', valor: Math.max(+valor || 100, 0.01).toFixed(2), gtin: 'SEM GTIN', codigoInterno: ncm });
    try {
      const r = await ibGet(IBPT_API + '?' + q.toString(), 10000), x = ibLer(r.text, tk);
      db.prepare('insert or replace into ibpt_api(uf,ncm,ex,fn,fi,est,mun,chave,versao,fonte,fim,em) values(?,?,?,?,?,?,?,?,?,?,?,?)').run(c.uf, ncm, ex, x.fn, x.fi, x.est, x.mun, x.chave, x.versao, x.fonte, x.fim, new Date().toISOString());
      ibOk = new Date().toISOString(); ibErro = ''; return qIa.get(c.uf, ncm, ex);
    } catch (e) {
      const m = /^IBPT:/.test(e.message) ? e.message : 'Não consegui falar com o IBPT: ' + tiraToken(e.message, tk).slice(0, 200);
      if (!/^IBPT:/.test(e.message)) ibCaiu = Date.now(); ibErro = m; throw new Error(m);
    }
  }
  /* precisa perguntar à API por este NCM? (conforme o modo) */
  function ibPrecisa(ncm, ex) {
    const md = ibModo(), c = cfg(); if (md == 'off' || md == 'tabela' || !c.ibptToken || !c.uf) return false;
    if (apiValida(qIa.get(c.uf, ncm, ex || ''))) return false;
    if (md == 'api') return true;
    return !(qIb.get(ncm, ex || '') || qIb.get(ncm, '')) || tabVencida();   // auto: só o que falta na tabela, ou tudo se a tabela venceu
  }
  /* antes de emitir: tenta completar pela API, no máximo ~2,5 s (sem internet a nota sai do mesmo jeito) */
  async function ibptGarantir(ncms, ms = 2500) {
    const l = [...new Set((ncms || []).map(n => dg(n)).filter(n => n.length == 8 && ibPrecisa(n, '')))].slice(0, 12); if (!l.length) return;
    await Promise.race([Promise.allSettled(l.map(n => ibptApi(n, ''))), new Promise(r => setTimeout(r, ms))]);
  }
  /* de tempos em tempos busca na API os NCMs dos produtos que precisam (devagar, para não sobrecarregar) */
  let ibFila = false;
  async function ibptPreencher(max = 150) {
    if (ibFila) return { msg: 'Busca em andamento.' }; ibFila = true; let n = 0, err = 0;
    try {
      const ncms = db.prepare("select distinct json_extract(data,'$.ncm') ncm from products where length(json_extract(data,'$.ncm'))=8").all().map(r => r.ncm).filter(x => ibPrecisa(x, ''));
      for (const x of ncms.slice(0, max)) { try { await ibptApi(x, ''); n++ } catch (e) { err++; if (Date.now() - ibCaiu < 1000) break } await new Promise(r => setTimeout(r, 350)) }
      return { buscados: n, erros: err, faltam: Math.max(0, ncms.length - n) };
    } finally { ibFila = false }
  }
  setTimeout(() => ibptPreencher().catch(() => { }), 120e3);
  setInterval(() => ibptPreencher().catch(() => { }), 6 * 3600e3);
  /* alíquotas do item: importado (origem 1,2,3,8) usa a federal de importados. Conjuga tabela e API conforme o modo. */
  function ibptDe(ncm, ex, orig) {
    const md = ibModo(); if (md == 'off') return null;
    const imp = [1, 2, 3, 8].includes(+orig), uf = cfg().uf;
    const tab = () => { const r = qIb.get(ncm, ex || '') || qIb.get(ncm, ''); if (!r) return null; const m = ibptMeta() || {}; return { fed: imp ? r.fi : r.fn, est: r.est, mun: r.mun, src: 'tabela', chave: m.chave, fonte: m.fonte } };
    const api = () => { if (md == 'tabela') return null; const r = qIa.get(uf, ncm, ex || '') || qIa.get(uf, ncm, ''); if (!r || !apiValida(r)) return null; return { fed: imp ? r.fi : r.fn, est: r.est, mun: r.mun || 0, src: 'api', chave: r.chave, fonte: r.fonte } };
    if (md == 'api') return api() || tab();
    if (md == 'auto' && tabVencida()) return api() || tab();
    return tab() || api();
  }
  function ibptStatus() {
    const m = ibptMeta(), hoje = new Date().toISOString().slice(0, 10), c = cfg();
    const ncms = db.prepare("select distinct json_extract(data,'$.ncm') ncm from products where length(json_extract(data,'$.ncm'))=8").all().map(r => r.ncm);
    const sem = ncms.filter(n => !qIb.get(n, '')), semAmbas = sem.filter(n => !apiValida(qIa.get(c.uf, n, '')));
    const napi = db.prepare('select count(*) n from ibpt_api where uf=?').get(c.uf || '').n;
    return { ...(m || {}), uf: (m && m.uf) || c.uf || '', vencida: !!(m && dBr(m.fim) && dBr(m.fim) < hoje), ncmsLoja: ncms.length, ncmsSemTabela: sem.slice(0, 30), nSem: sem.length,
      semAmbas: semAmbas.slice(0, 30), nSemAmbas: semAmbas.length, modo: ibModo(), temToken: !!c.ibptToken, api: { n: napi, ult: ibOk, erro: ibErro, pausada: Date.now() - ibCaiu < 600e3 } };
  }
  async function ibptTestar() {
    const c = cfg(), p = db.prepare("select json_extract(data,'$.ncm') ncm, json_extract(data,'$.n') n from products where length(json_extract(data,'$.ncm'))=8 limit 1").get();
    const ncm = (p && p.ncm) || '22021000', r = await ibptApi(ncm, '', true, p && p.n);
    return { ok: true, ncm, produto: p ? p.n : 'refrigerante (exemplo)', nacional: r.fn, importado: r.fi, estadual: r.est, municipal: r.mun, chave: r.chave, versao: r.versao, fim: r.fim, uf: c.uf };
  }


  /* ================= NF-e modelo 55 =================
     Venda (para empresa / "nota no CNPJ") e devolução ao fornecedor (finNFe 4, com a nota original
     referenciada). Mesma assinatura da NFC-e; autorizadora da NF-e da UF (sefaz.json). Precisa de internet na hora. */
  db.exec(`create table if not exists nfe55(chave text primary key, serie integer, num integer, st text, data text not null, xml text, updated_at text);`);
  const ws55 = () => { const c = cfg(); return UFS[c.uf].ws55[c.amb] };
  const MUNF = [path.join(__dirname, 'lib', 'municipios.json.gz'), path.join(__dirname, 'ibpt', 'municipios.json.gz')].find(f => fs.existsSync(f)) || path.join(__dirname, 'lib', 'municipios.json.gz');
  let MUN = null;
  const municipios = uf => { if (!MUN) MUN = JSON.parse(zlib.gunzipSync(fs.readFileSync(MUNF)).toString('utf8')); return MUN[String(uf || '').toUpperCase()] || [] };
  const CUF = { RO: 11, AC: 12, AM: 13, RR: 14, PA: 15, AP: 16, TO: 17, MA: 21, PI: 22, CE: 23, RN: 24, PB: 25, PE: 26, AL: 27, SE: 28, BA: 29, MG: 31, ES: 32, RJ: 33, SP: 35, PR: 41, SC: 42, RS: 43, MS: 50, MT: 51, GO: 52, DF: 53 };
  const reg55 = ch => { const r = db.prepare('select * from nfe55 where chave=?').get(ch); return r ? { ...r, data: J(r.data) } : null };
  function gravar55(chave, serie, num, st, data, xml) {
    db.prepare('insert into nfe55(chave,serie,num,st,data,xml,updated_at) values(?,?,?,?,?,?,?) on conflict(chave) do update set st=excluded.st, data=excluded.data, xml=coalesce(excluded.xml,nfe55.xml), updated_at=excluded.updated_at')
      .run(chave, serie, num, st, JSON.stringify(data), xml, new Date().toISOString());
  }
  const TPAG55 = { Dinheiro: '01', 'Crédito': '03', 'Débito': '04', Fiado: '05', Pix: '17', Boleto: '15', 'A prazo': '99', Transferência: '18' };

  function montar55(doc, o) {
    const c = cfg(), U = UFS[c.uf], tpAmb = c.amb, d = o.dhEmi || new Date(), dev = doc.tipo == 'devolucao';
    const D = doc.dest || {}, ddoc = dg(D.doc), ufD = String(D.uf || c.uf).toUpperCase();
    if (![11, 14].includes(ddoc.length)) throw new Error('Informe o CPF ou CNPJ do destinatário.');
    if (!String(D.nome || '').trim()) throw new Error('Informe o nome do destinatário.');
    if (!D.xLgr || !D.nro || !D.xBairro || !dg(D.cMun) || !CUF[ufD]) throw new Error('Preencha o endereço completo do destinatário (rua, número, bairro, cidade e UF).');
    const indIE = [1, 2, 9].includes(+D.indIEDest) ? +D.indIEDest : (dg(D.ie) ? 1 : 9);
    if (indIE == 1 && !dg(D.ie)) throw new Error('Informe a inscrição estadual do destinatário (ou marque "não contribuinte").');
    const idDest = ufD == c.uf ? 1 : 2, indFinal = dev ? 0 : (indIE == 1 ? 0 : 1);
    if (!dev && idDest == 2 && indFinal == 1) throw new Error('Venda para consumidor final de outro estado precisa de cálculo de DIFAL: fale com o contador antes de emitir.');
    if (dev && dg(doc.ref).length != 44) throw new Error('Escolha a nota de compra que está sendo devolvida.');
    const itens = (doc.itens || []).filter(i => +i.q > 0); if (!itens.length) throw new Error('Inclua pelo menos um item.');
    const vProdL = itens.map(i => r2(+i.q * +i.vUn)), vDescL = itens.map(i => r2(+i.vDesc || 0));
    const vFrete = r2(+((doc.frete || {}).valor) || 0), vFreteL = ratear(vFrete, vProdL);
    const vProd = r2(vProdL.reduce((s, x) => s + x, 0)), vDesc = r2(vDescL.reduce((s, x) => s + x, 0)), vNF = r2(vProd - vDesc + vFrete);
    const cNF = o.cNF || String(crypto.randomInt(10000000, 99999999));
    const aamm = d.getFullYear().toString().slice(2) + String(d.getMonth() + 1).padStart(2, '0');
    const base = String(U.cUF) + aamm + c.cnpj.padStart(14, '0') + '55' + String(c.serie55).padStart(3, '0') + String(o.num).padStart(9, '0') + '1' + cNF;
    const chave = base + dv11(base);
    const trib = { fed: 0, est: 0, mun: 0 };
    const det = itens.map((i, k) => {
      const ncm = dg(i.ncm); if (ncm.length != 8) throw new Error('NCM_FALTA: o item "' + i.xProd + '" está sem NCM (8 números).');
      const u = String(i.u || 'UN').toUpperCase().slice(0, 6), g = gtinOk(i.ean) ? dg(i.ean) : 'SEM GTIN', st = String(i.csosn) == '500';
      const cfop = String(i.cfop || (dev ? (idDest == 1 ? (st ? '5411' : '5202') : (st ? '6411' : '6202')) : (idDest == 1 ? (st ? '5405' : '5102') : (st ? '6404' : '6102'))));
      const icms = dev ? `<ICMSSN900><orig>${+i.orig || 0}</orig><CSOSN>900</CSOSN></ICMSSN900>` : st ? `<ICMSSN500><orig>${+i.orig || 0}</orig><CSOSN>500</CSOSN></ICMSSN500>` : `<ICMSSN102><orig>${+i.orig || 0}</orig><CSOSN>102</CSOSN></ICMSSN102>`;
      let vt = 0;
      if (indFinal == 1) { const al = ibptDe(ncm, '', i.orig); if (al) { if (al.src == 'tabela') trib.usouTab = 1; else trib.api55 = al; const b = r2(vProdL[k] - vDescL[k] + vFreteL[k]), a = r2(b * al.fed / 100), e = r2(b * al.est / 100), m = r2(b * al.mun / 100); trib.fed += a; trib.est += e; trib.mun += m; vt = r2(a + e + m) } }
      const vu = (+i.vUn).toFixed(10).replace(/0{1,8}$/, '');
      return `<det nItem="${k + 1}"><prod><cProd>${txt(i.cProd || i.pid || String(k + 1), 60)}</cProd><cEAN>${g}</cEAN><xProd>${tpAmb == 2 && k == 0 ? 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : txt(i.xProd, 120)}</xProd><NCM>${ncm}</NCM>${el('CEST', dg(i.cest).length == 7 ? dg(i.cest) : '')}<CFOP>${cfop}</CFOP><uCom>${txt(u, 6)}</uCom><qCom>${f4(i.q)}</qCom><vUnCom>${vu}</vUnCom><vProd>${f2(vProdL[k])}</vProd><cEANTrib>${g}</cEANTrib><uTrib>${txt(u, 6)}</uTrib><qTrib>${f4(i.q)}</qTrib><vUnTrib>${vu}</vUnTrib>${vFreteL[k] ? `<vFrete>${f2(vFreteL[k])}</vFrete>` : ''}${vDescL[k] ? `<vDesc>${f2(vDescL[k])}</vDesc>` : ''}<indTot>1</indTot></prod>`
        + `<imposto>${vt > 0 ? `<vTotTrib>${f2(vt)}</vTotTrib>` : ''}<ICMS>${icms}</ICMS><PIS><PISOutr><CST>99</CST><vBC>0.00</vBC><pPIS>0.0000</pPIS><vPIS>0.00</vPIS></PISOutr></PIS><COFINS><COFINSOutr><CST>99</CST><vBC>0.00</vBC><pCOFINS>0.0000</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS></imposto></det>`;
    }).join('');
    ['fed', 'est', 'mun'].forEach(k => trib[k] = r2(trib[k])); trib.tot = r2(trib.fed + trib.est + trib.mun);
    const im = ibptMeta();
    const pags = dev ? [] : (doc.pag || []).filter(g => +g.v > 0);
    const detPag = dev || !pags.length ? (dev ? '<detPag><tPag>90</tPag><vPag>0.00</vPag></detPag>' : `<detPag><tPag>01</tPag><vPag>${f2(vNF)}</vPag></detPag>`)
      : pags.map(g => { const t = TPAG55[g.f] || '99'; return `<detPag>${t == '99' || t == '15' ? '<indPag>1</indPag>' : ''}<tPag>${t}</tPag>${t == '99' ? `<xPag>${txt(g.f, 60)}</xPag>` : ''}<vPag>${f2(g.v)}</vPag>${['03', '04', '17'].includes(t) ? '<card><tpIntegra>2</tpIntegra></card>' : ''}</detPag>` }).join('');
    const dnome = tpAmb == 2 ? 'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' : txt(D.nome, 60);
    const dest = `<dest>${ddoc.length == 14 ? `<CNPJ>${ddoc}</CNPJ>` : `<CPF>${ddoc}</CPF>`}<xNome>${dnome}</xNome><enderDest><xLgr>${txt(D.xLgr, 60)}</xLgr><nro>${txt(D.nro, 60)}</nro>${el('xCpl', txt(D.xCpl, 60))}<xBairro>${txt(D.xBairro, 60)}</xBairro><cMun>${dg(D.cMun)}</cMun><xMun>${txt(D.xMun, 60)}</xMun><UF>${ufD}</UF>${dg(D.cep).length == 8 ? `<CEP>${dg(D.cep)}</CEP>` : ''}<cPais>1058</cPais><xPais>BRASIL</xPais>${dg(D.fone).length >= 6 ? `<fone>${dg(D.fone)}</fone>` : ''}</enderDest><indIEDest>${indIE}</indIEDest>${indIE == 1 ? `<IE>${dg(D.ie)}</IE>` : ''}${D.email ? `<email>${txt(D.email, 60)}</email>` : ''}</dest>`;
    const ender = `<enderEmit><xLgr>${txt(c.xLgr, 60)}</xLgr><nro>${txt(c.nro, 60)}</nro><xBairro>${txt(c.xBairro, 60)}</xBairro><cMun>${c.cMun}</cMun><xMun>${txt(c.xMun, 60)}</xMun><UF>${c.uf}</UF><CEP>${c.cep}</CEP><cPais>1058</cPais><xPais>BRASIL</xPais>${el('fone', c.fone.length >= 6 ? c.fone : '')}</enderEmit>`;
    const respTec = c.rtCnpj && c.rtContato && c.rtEmail && c.rtFone ? `<infRespTec><CNPJ>${c.rtCnpj}</CNPJ><xContato>${txt(c.rtContato, 60)}</xContato><email>${txt(c.rtEmail, 60)}</email><fone>${c.rtFone}</fone></infRespTec>` : '';
    const mf = [0, 1, 2, 9].includes(+((doc.frete || {}).mod)) ? +doc.frete.mod : 9;
    const cpl = [dev ? `Devolucao referente a NF-e ${String(doc.refNum || '')} chave ${dg(doc.ref)}.` : '', 'DOCUMENTO EMITIDO POR ME OU EPP OPTANTE PELO SIMPLES NACIONAL. NAO GERA DIREITO A CREDITO FISCAL DE IPI.', doc.obs || '',
      trib.tot > 0 ? `Trib aprox R$ ${f2(trib.fed).replace('.', ',')} Federal, R$ ${f2(trib.est).replace('.', ',')} Estadual e R$ ${f2(trib.mun).replace('.', ',')} Municipal. Fonte: ${(!trib.usouTab && trib.api55 ? trib.api55.fonte : im && im.fonte) || 'IBPT'} ${(!trib.usouTab && trib.api55 ? trib.api55.chave : im && im.chave) || ''}` : ''].filter(Boolean).join(' ');
    const natOp = txt(doc.natOp || (dev ? 'DEVOLUCAO DE COMPRA PARA COMERCIALIZACAO' : 'VENDA DE MERCADORIA'), 60);
    const inf = `<infNFe Id="NFe${chave}" versao="4.00"><ide><cUF>${U.cUF}</cUF><cNF>${cNF}</cNF><natOp>${natOp}</natOp><mod>55</mod><serie>${c.serie55}</serie><nNF>${o.num}</nNF><dhEmi>${dh(d)}</dhEmi><dhSaiEnt>${dh(d)}</dhSaiEnt><tpNF>1</tpNF><idDest>${idDest}</idDest><cMunFG>${c.cMun}</cMunFG><tpImp>1</tpImp><tpEmis>1</tpEmis><cDV>${chave.slice(-1)}</cDV><tpAmb>${tpAmb}</tpAmb><finNFe>${dev ? 4 : 1}</finNFe><indFinal>${indFinal}</indFinal><indPres>${dev ? 0 : 1}</indPres><procEmi>0</procEmi><verProc>AdaptaSys Mercado 1.0</verProc>${dev ? `<NFref><refNFe>${dg(doc.ref)}</refNFe></NFref>` : ''}</ide>`
      + `<emit><CNPJ>${c.cnpj}</CNPJ><xNome>${txt(c.xNome, 60)}</xNome>${el('xFant', txt(c.xFant, 60))}${ender}<IE>${c.ie}</IE><CRT>${c.crt}</CRT></emit>${dest}${det}`
      + `<total><ICMSTot><vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson><vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet><vProd>${f2(vProd)}</vProd><vFrete>${f2(vFrete)}</vFrete><vSeg>0.00</vSeg><vDesc>${f2(vDesc)}</vDesc><vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol><vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro><vNF>${f2(vNF)}</vNF>${trib.tot > 0 ? `<vTotTrib>${f2(trib.tot)}</vTotTrib>` : ''}</ICMSTot></total>`
      + `<transp><modFrete>${mf}</modFrete></transp><pag>${detPag}</pag><infAdic><infCpl>${txt(cpl, 4000)}</infCpl></infAdic>${respTec}</infNFe>`;
    const { sig } = assinar(inf, NS);
    return { xml: `<NFe xmlns="${NS}">${inf}${sig}</NFe>`, chave, cNF, vNF, trib };
  }

  function emitir55(doc, ctx) {
    return serial(async () => {
      const c = cfg(); if (!c.cnpj || !fs.existsSync(CERTF)) throw new Error('Configure a parte fiscal (certificado e dados) em Gestão > Fiscal.');
      let reusa = null;
      if (doc.refazer) { const r0 = reg55(doc.refazer); if (r0 && ['rejeitada', 'erro'].includes(r0.st)) { reusa = r0; doc = { ...r0.data.doc, ...doc, refazer: undefined } } }
      const num = reusa ? reusa.num : c.num55;
      try { await ibptGarantir((doc.itens || doc.items || []).map(i => i.ncm)) } catch (e) { }
      const m = montar55(doc, { num });
      if (!reusa) kvSet('fiscal', { ...cfg(), num55: num + 1 });
      if (reusa) db.prepare('delete from nfe55 where chave=?').run(reusa.chave);
      const info = { doc, total: m.vNF, trib: m.trib, dhEmi: dh(), tpAmb: c.amb, tipo: doc.tipo, dest: (doc.dest || {}).nome, ddoc: dg((doc.dest || {}).doc), op: ctx && ctx.op && ctx.op.n };
      try {
        const lote = String(Date.now()).slice(-15);
        const r = await soap(ws55().aut, 'NFeAutorizacao4', `<enviNFe xmlns="${NS}" versao="4.00"><idLote>${lote}</idLote><indSinc>1</indSinc>${m.xml}</enviNFe>`, 30000);
        const prot = (r.match(/<protNFe[\s\S]*?<\/protNFe>/) || [])[0] || '', cs = tag(r, 'cStat') == '104' ? tag(prot, 'cStat') : tag(r, 'cStat'), xm = tag(r, 'cStat') == '104' ? tag(prot, 'xMotivo') : tag(r, 'xMotivo');
        if (STOK.includes(cs)) {
          const x = proc(m.xml, prot); arquivo(m.chave, x, 'nfe');
          gravar55(m.chave, c.serie55, num, 'autorizada', { ...info, nProt: tag(prot, 'nProt'), dhRecbto: tag(prot, 'dhRecbto'), cStat: cs, xMotivo: xm }, x);
          log('NF-e 55 autorizada', c.serie55 + '/' + num, doc.tipo, 'R$', m.vNF.toFixed(2));
        } else gravar55(m.chave, c.serie55, num, ['110', '301', '302', '303'].includes(cs) ? 'denegada' : 'rejeitada', { ...info, cStat: cs, xMotivo: xm }, m.xml);
      } catch (e) {
        gravar55(m.chave, c.serie55, num, 'erro', { ...info, xMotivo: e instanceof SemRede ? 'Sem comunicação com a SEFAZ (' + e.message + '). A NF-e precisa de internet: tente de novo.' : e.message }, m.xml);
      }
      return resumo55(reg55(m.chave));
    });
  }
  const resumo55 = r => r ? { chave: r.chave, serie: r.serie, num: r.num, st: r.st, ...r.data, doc: undefined } : null;
  function lista55() {
    return db.prepare('select chave,serie,num,st,data from nfe55 order by serie, num desc limit 1000').all().map(r => { const d = J(r.data) || {}; return { chave: r.chave, serie: r.serie, num: r.num, st: r.st, total: d.total, dhEmi: d.dhEmi, tipo: d.tipo, dest: d.dest, ddoc: d.ddoc, cStat: d.cStat, xMotivo: d.xMotivo, tpAmb: d.tpAmb, cce: (d.cce || []).length, estoque: !!d.estoque } });
  }
  /* eventos da NF-e 55: cancelamento e carta de correção */
  const COND_CCE = 'A Carta de Correcao e disciplinada pelo paragrafo 1o-A do art. 7o do Convenio S/N, de 15 de dezembro de 1970 e pode ser utilizada para regularizacao de erro ocorrido na emissao de documento fiscal, desde que o erro nao esteja relacionado com: I - as variaveis que determinam o valor do imposto tais como: base de calculo, aliquota, diferenca de preco, quantidade, valor da operacao ou da prestacao; II - a correcao de dados cadastrais que implique mudanca do remetente ou do destinatario; III - a data de emissao ou de saida.';
  async function evento55(chave, tp, det, seq) {
    const c = cfg(), dt = dh(), id = `ID${tp}${chave}${String(seq).padStart(2, '0')}`;
    const inf = `<infEvento Id="${id}"><cOrgao>${UFS[c.uf].cUF}</cOrgao><tpAmb>${c.amb}</tpAmb><CNPJ>${c.cnpj}</CNPJ><chNFe>${chave}</chNFe><dhEvento>${dt}</dhEvento><tpEvento>${tp}</tpEvento><nSeqEvento>${seq}</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00">${det}</detEvento></infEvento>`;
    const evento = `<evento xmlns="${NS}" versao="1.00">${inf}${assinar(inf, NS).sig}</evento>`;
    const r = await soap(ws55().evt, 'NFeRecepcaoEvento4', `<envEvento xmlns="${NS}" versao="1.00"><idLote>${String(Date.now()).slice(-15)}</idLote>${evento}</envEvento>`);
    const ret = (r.match(/<retEvento[\s\S]*?<\/retEvento>/) || [])[0] || '', cs = tag(ret, 'cStat') || tag(r, 'cStat'), xm = tag(ret, 'xMotivo') || tag(r, 'xMotivo');
    if (!['135', '136', '155'].includes(cs)) throw new Error(`SEFAZ não aceitou: ${cs} - ${xm}`);
    return { dt, nProt: tag(ret, 'nProt'), xml: `<procEventoNFe xmlns="${NS}" versao="1.00">${evento.replace(` xmlns="${NS}"`, '')}${ret.replace(/ xmlns="[^"]*"/, '')}</procEventoNFe>` };
  }
  async function cancelar55(chave, just) {
    const r0 = reg55(chave); if (!r0 || r0.st != 'autorizada') throw new Error('Só dá para cancelar NF-e autorizada.');
    just = String(just || '').trim(); if (just.length < 15) throw new Error('Escreva o motivo do cancelamento (mínimo 15 letras).');
    const ev = await evento55(chave, '110111', `<descEvento>Cancelamento</descEvento><nProt>${r0.data.nProt}</nProt><xJust>${txt(just, 255)}</xJust>`, 1);
    arquivo(chave, ev.xml, 'canc');
    gravar55(chave, r0.serie, r0.num, 'cancelada', { ...r0.data, canc: { dh: ev.dt, just, nProt: ev.nProt } }, null);
    log('NF-e 55 CANCELADA', r0.num, just); return resumo55(reg55(chave));
  }
  async function cce55(chave, texto) {
    const r0 = reg55(chave); if (!r0 || r0.st != 'autorizada') throw new Error('Carta de correção só para NF-e autorizada.');
    texto = String(texto || '').trim(); if (texto.length < 15) throw new Error('Escreva a correção (mínimo 15 letras).');
    const seq = (r0.data.cce || []).length + 1; if (seq > 20) throw new Error('Limite de 20 cartas de correção.');
    const ev = await evento55(chave, '110110', `<descEvento>Carta de Correcao</descEvento><xCorrecao>${txt(texto, 1000)}</xCorrecao><xCondUso>${COND_CCE}</xCondUso>`, seq);
    arquivo(chave, ev.xml, 'cce' + seq);
    gravar55(chave, r0.serie, r0.num, 'autorizada', { ...r0.data, cce: [...(r0.data.cce || []), { seq, dh: ev.dt, texto, nProt: ev.nProt }] }, null);
    log('NF-e 55 carta de correção', r0.num, seq); return resumo55(reg55(chave));
  }
  /* inutilização de numeração (NFC-e 65 ou NF-e 55) */
  async function inutilizar(b) {
    const c = cfg(), mod = +b.mod == 55 ? 55 : 65, serie = Math.max(0, +b.serie || 0), ini = +b.ini || 0, fim = +b.fim || ini, just = String(b.just || '').trim();
    if (!(ini > 0) || fim < ini) throw new Error('Informe o número (ou a faixa) a inutilizar.');
    if (just.length < 15) throw new Error('Escreva o motivo (mínimo 15 letras).');
    const usado = db.prepare(`select num from ${mod == 55 ? 'nfe55' : 'nfce'} where serie=? and num between ? and ? and st in ('autorizada','contingencia','cancelada','denegada') limit 1`).get(serie, ini, fim);
    if (usado) throw new Error('O número ' + usado.num + ' já foi usado numa nota. Não dá para inutilizar.');
    const ano = String(new Date().getFullYear()).slice(2), U = UFS[c.uf];
    const id = 'ID' + U.cUF + ano + c.cnpj + mod + String(serie).padStart(3, '0') + String(ini).padStart(9, '0') + String(fim).padStart(9, '0');
    const inf = `<infInut Id="${id}"><tpAmb>${c.amb}</tpAmb><xServ>INUTILIZAR</xServ><cUF>${U.cUF}</cUF><ano>${ano}</ano><CNPJ>${c.cnpj}</CNPJ><mod>${mod}</mod><serie>${serie}</serie><nNFIni>${ini}</nNFIni><nNFFin>${fim}</nNFFin><xJust>${txt(just, 255)}</xJust></infInut>`;
    const x = `<inutNFe xmlns="${NS}" versao="4.00">${inf}${assinar(inf, NS).sig}</inutNFe>`;
    const r = await soap((mod == 55 ? ws55() : ws()).inut, 'NFeInutilizacao4', x);
    const cs = tag(r, 'cStat'), xm = tag(r, 'xMotivo');
    if (cs != '102') throw new Error(`SEFAZ não aceitou: ${cs} - ${xm}`);
    const ret = (r.match(/<retInutNFe[\s\S]*?<\/retInutNFe>/) || [])[0] || '';
    const dd = path.join(XMLD, 'inutilizadas'); fs.mkdirSync(dd, { recursive: true });
    fs.writeFileSync(path.join(dd, `${id.slice(2)}-inu.xml`), `<?xml version="1.0" encoding="UTF-8"?><ProcInutNFe xmlns="${NS}" versao="4.00">${x.replace(` xmlns="${NS}"`, '')}${ret.replace(/ xmlns="[^"]*"/, '')}</ProcInutNFe>`);
    const l = kvGet('inut') || []; l.unshift({ mod, serie, ini, fim, just, dh: dh(), nProt: tag(ret, 'nProt'), amb: c.amb }); kvSet('inut', l.slice(0, 200));
    log('INUTILIZADA', 'mod', mod, 'série', serie, ini + '-' + fim, just); return { ok: true, nProt: tag(ret, 'nProt') };
  }
  /* dados para o DANFE A4 (lidos do XML autorizado) */
  function danfe55(chave) {
    const r = reg55(chave); if (!r || !r.xml) throw new Error('NF-e não encontrada.');
    const x = r.xml, d = r.data, un = s => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const blk = n => tag(x, n), emit = blk('emit'), dest = blk('dest'), ide = blk('ide'), tot = blk('ICMSTot'), ed = tag(dest, 'enderDest'), ee = tag(emit, 'enderEmit');
    const itens = [...x.matchAll(/<det nItem="\d+"><prod>([\s\S]*?)<\/prod><imposto>([\s\S]*?)<\/imposto><\/det>/g)].map(([, p, im]) => ({ cod: un(tag(p, 'cProd')), desc: un(tag(p, 'xProd')), ncm: tag(p, 'NCM'), csosn: tag(im, 'CSOSN'), cfop: tag(p, 'CFOP'), un: tag(p, 'uCom'), q: +tag(p, 'qCom'), vu: +tag(p, 'vUnCom'), vt: +tag(p, 'vProd'), vd: +tag(p, 'vDesc') || 0 }));
    return { chave, num: r.num, serie: r.serie, st: r.st, tpAmb: d.tpAmb, nProt: d.nProt, dhRecbto: d.dhRecbto, canc: d.canc, cce: d.cce,
      natOp: un(tag(ide, 'natOp')), dhEmi: tag(ide, 'dhEmi'), tpNF: tag(ide, 'tpNF'), refNFe: tag(ide, 'refNFe'),
      emit: { nome: un(tag(emit, 'xNome')), fant: un(tag(emit, 'xFant')), cnpj: tag(emit, 'CNPJ'), ie: tag(emit, 'IE'), end: `${un(tag(ee, 'xLgr'))}, ${un(tag(ee, 'nro'))} - ${un(tag(ee, 'xBairro'))}`, mun: un(tag(ee, 'xMun')) + '/' + tag(ee, 'UF'), cep: tag(ee, 'CEP'), fone: tag(ee, 'fone') },
      dest: { nome: un(tag(dest, 'xNome')), doc: tag(dest, 'CNPJ') || tag(dest, 'CPF'), ie: tag(dest, 'IE'), end: `${un(tag(ed, 'xLgr'))}, ${un(tag(ed, 'nro'))}`, bairro: un(tag(ed, 'xBairro')), mun: un(tag(ed, 'xMun')), uf: tag(ed, 'UF'), cep: tag(ed, 'CEP'), fone: tag(ed, 'fone') },
      tot: { vProd: +tag(tot, 'vProd'), vFrete: +tag(tot, 'vFrete'), vDesc: +tag(tot, 'vDesc'), vNF: +tag(tot, 'vNF'), vTotTrib: +tag(tot, 'vTotTrib') || 0 },
      modFrete: tag(blk('transp'), 'modFrete'), infCpl: un(tag(x, 'infCpl')), itens };
  }
  function xml55(chave) { const r = reg55(chave); if (!r || !r.xml) return null; return '<?xml version="1.0" encoding="UTF-8"?>' + r.xml }
  const marca55 = (chave, patch) => { const r = reg55(chave); if (r) gravar55(chave, r.serie, r.num, r.st, { ...r.data, ...patch }, null) };

  const estado = () => { const c = cfg(); return { on: !!c.on, amb: c.amb, serie: c.serie, pend: c.on ? pendentes().length : 0, pendHoras: c.on ? pendHoras() : 0 } };

  return { parteLoja, parteParceiros, ehParc, municipios, emitir55, lista55, cancelar55, cce55, inutilizar, danfe55, marca55, reg55, inutLista: () => kvGet('inut') || [], ibptStatus, ibptImportar, ibptExportar, ibptAtualizar, ibptDe, ibptTestar, ibptPreencher, ibptApi, distBuscar, distLista, distXml, distPedir, distEstado, ciencia, cfg, cfgPublic, salvarCfg, salvarCert, statusServico, consultar, emitir, enviarPendentes, cancelar, danfe, lista, daVenda, xmlDe, zipMes, resumoDia, estado, montar, assinar, _lerPfx: lerPfx };
};
