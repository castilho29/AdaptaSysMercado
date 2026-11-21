'use strict';
/* Integração Mercado Pago.
   O Access Token fica SÓ neste computador (dados do servidor, nunca vai para o Supabase nem para o app).
   - Pix no caixa: cobrança Pix com o valor exato, confirmada sozinha
   - Maquininha Point (modo PDV): o caixa manda o valor para a maquininha e recebe a confirmação
   - App do cliente: Pix (QR + copia e cola) e link de cartão (Checkout Pro), conferidos pelo servidor */
const crypto = require('crypto');

module.exports = function ({ kvGet, kvSet, log, raw, base }) {
  const BASE = String(base || 'https://api.mercadopago.com').replace(/\/$/, '');
  const cfg = () => kvGet('mp') || {};
  const temToken = () => !!cfg().token;

  async function req(p, { method = 'GET', body, idem, headers = {}, token } = {}) {
    const tk = token || cfg().token; if (!tk) throw new Error('Mercado Pago não configurado (Gestão > Mercado Pago).');
    const h = { Authorization: 'Bearer ' + tk, 'content-type': 'application/json', ...headers };
    if (idem) h['X-Idempotency-Key'] = idem;
    const r = await raw(BASE + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined }, 25000);
    const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null } catch (e) { }
    if (!r.ok) {
      const det = j && ((j.errors && j.errors[0] && (j.errors[0].message || j.errors[0].details)) || (j.cause && j.cause[0] && j.cause[0].description) || j.message || j.error);
      const e = new Error(r.status == 401 ? 'Mercado Pago recusou o token (confira o Access Token).' : 'Mercado Pago: ' + (det || 'erro ' + r.status)); e.status = r.status; e.mp = j; throw e;
    }
    return j;
  }
  const valor = v => Math.round((+v || 0) * 100) / 100;
  const isoEm = min => { const d = new Date(Date.now() + min * 60000); return d.toISOString().replace('Z', '-00:00') };   // formato aceito pelo MP (yyyy-MM-ddTHH:mm:ss.SSS-00:00)
  const refOk = s => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || ('MO' + Date.now());
  const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '')) ? String(e).trim() : '';

  /* ---------- conta ---------- */
  async function testar(token) {
    const u = await req('/users/me', { token });
    return { id: u.id, nome: u.nickname || [u.first_name, u.last_name].filter(Boolean).join(' '), email: u.email || '', teste: /^TEST-/.test(token) || !!(u.tags || []).includes('test_user') };
  }

  /* ---------- Pix (caixa e app) ---------- */
  async function pixCriar({ v, ref, desc, email, min = 15, cpf }) {
    const val = valor(v); if (!(val >= 0.01)) throw new Error('Valor inválido para o Pix.');
    const doc = String(cpf || '').replace(/\D/g, '');
    const body = { transaction_amount: val, payment_method_id: 'pix', description: String(desc || 'Compra').slice(0, 120), external_reference: refOk(ref), date_of_expiration: isoEm(Math.max(5, Math.min(min, 1440))),
      payer: { email: emailOk(email) || emailOk(cfg().email) || 'cliente@mercadoonline.app', ...(doc.length == 11 || doc.length == 14 ? { identification: { type: doc.length == 11 ? 'CPF' : 'CNPJ', number: doc } } : {}) } };
    const p = await req('/v1/payments', { method: 'POST', body, idem: crypto.randomUUID() });
    const t = (p.point_of_interaction && p.point_of_interaction.transaction_data) || {};
    return { id: String(p.id), st: p.status, qr: t.qr_code || '', qr64: t.qr_code_base64 || '', link: t.ticket_url || '', exp: p.date_of_expiration || '', v: val };
  }
  async function pagamento(id) {
    const p = await req('/v1/payments/' + encodeURIComponent(id));
    return resumoPag(p);
  }
  const resumoPag = p => ({ id: String(p.id), st: p.status, det: p.status_detail || '', tipo: tipoDe(p.payment_type_id, p.payment_method_id), v: valor(p.transaction_amount), parcelas: p.installments || 1, quando: p.date_approved || '' });
  const tipoDe = (t, m) => t == 'debit_card' || t == 'prepaid_card' ? 'Débito' : t == 'credit_card' ? 'Crédito' : 'Pix';   // Pix, saldo em conta e outros = Pix (tPag 17 na NFC-e)
  async function pixCancelar(id) { try { await req('/v1/payments/' + encodeURIComponent(id), { method: 'PUT', body: { status: 'cancelled' } }) } catch (e) { if (e.status != 400 && e.status != 404) throw e } return { ok: true } }
  async function pagamentosDe(ref) {
    const j = await req('/v1/payments/search?sort=date_created&criteria=desc&limit=20&external_reference=' + encodeURIComponent(refOk(ref)));
    return (j && j.results || []).map(resumoPag);
  }
  async function estornarPagamento(id, v) {
    return req('/v1/payments/' + encodeURIComponent(id) + '/refunds', { method: 'POST', body: v ? { amount: valor(v) } : {}, idem: 'ref-' + id + '-' + (v || 'total') });
  }

  /* ---------- link de cartão para o app (Checkout Pro) ---------- */
  async function linkCriar({ v, ref, titulo, min = 30, email }) {
    const body = { items: [{ id: refOk(ref), title: String(titulo || 'Pedido').slice(0, 250), quantity: 1, unit_price: valor(v), currency_id: 'BRL' }], external_reference: refOk(ref),
      payer: emailOk(email) ? { email: emailOk(email) } : undefined, payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }], installments: 12 }, binary_mode: true,
      expires: true, expiration_date_from: isoEm(-1), expiration_date_to: isoEm(min), statement_descriptor: String(cfg().fatura || '').replace(/[^A-Za-z0-9 ]/g, '').slice(0, 13) || undefined };
    const p = await req('/checkout/preferences', { method: 'POST', body, idem: crypto.randomUUID() });
    return { id: p.id, link: p.init_point || '' };
  }

  /* ---------- maquininha Point (API de Orders) ---------- */
  async function terminais() {
    const j = await req('/terminals/v1/list?limit=50');
    return ((j && j.data && j.data.terminals) || []).map(t => ({ id: t.id, modo: t.operating_mode || '', loja: t.store_id || '', caixa: t.pos_id || '' }));
  }
  async function modoPdv(id) { return req('/terminals/v1/setup', { method: 'PATCH', body: { terminals: [{ id, operating_mode: 'PDV' }] } }) }
  async function pointCriar({ v, tipo, parcelas, ref, desc }) {
    const c = cfg(); if (!c.terminal) throw new Error('Escolha a maquininha em Gestão > Mercado Pago.');
    const val = valor(v); if (!(val >= 1)) throw new Error('A maquininha aceita a partir de R$ 1,00.');
    const pm = tipo == 'credito' ? { default_type: 'credit_card', ...(+parcelas > 1 ? { default_installments: +parcelas, installments_cost: c.juros == 'cliente' ? 'buyer' : 'seller' } : {}) } : tipo == 'debito' ? { default_type: 'debit_card' } : null;
    const body = { type: 'point', external_reference: refOk(ref), expiration_time: 'PT15M', description: String(desc || 'Venda').slice(0, 150),
      transactions: { payments: [{ amount: val.toFixed(2) }] }, config: { point: { terminal_id: c.terminal, print_on_terminal: c.via ? 'seller_ticket' : 'no_ticket' }, ...(pm ? { payment_method: pm } : {}) } };
    let o;
    try { o = await req('/v1/orders', { method: 'POST', body, idem: crypto.randomUUID() }) }
    catch (e) { if (e.status == 409) e.message = 'A maquininha já tem uma cobrança na fila. Cancele na maquininha ou aqui e tente de novo.'; if (e.status == 403) e.message = 'Essa maquininha não está ligada à sua conta ou não está no modo PDV.'; throw e }
    return { id: o.id, st: o.status };
  }
  async function pointVer(id) {
    const o = await req('/v1/orders/' + encodeURIComponent(id));
    const p = (o.transactions && o.transactions.payments && o.transactions.payments[0]) || {}, pm = p.payment_method || {};
    const tipo = pm.type == 'debit_card' || pm.type == 'prepaid_card' ? 'Débito' : pm.type == 'credit_card' ? 'Crédito' : (pm.type == 'qr' || pm.id == 'pix' || pm.type == 'bank_transfer') ? 'Pix' : '';
    return { id: o.id, st: o.status, det: p.status_detail || o.status_detail || '', tipo, parcelas: pm.installments || p.installments || 1, pagId: p.id || '', bandeira: pm.id || '' };
  }
  async function pointCancelar(id) {
    try { await req('/v1/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST', idem: crypto.randomUUID(), headers: { 'x-allow-cancelable-status': 'at_terminal' } }) }
    catch (e) { if (e.status != 409 && e.status != 400) throw e }
    return { ok: true };
  }
  async function pointEstornar(id) { return req('/v1/orders/' + encodeURIComponent(id) + '/refund', { method: 'POST', idem: 'ref-' + id }) }

  return { cfg, temToken, req, testar, pixCriar, pagamento, pixCancelar, pagamentosDe, estornarPagamento, linkCriar, terminais, modoPdv, pointCriar, pointVer, pointCancelar, pointEstornar, salvar: c => kvSet('mp', c) };
};
