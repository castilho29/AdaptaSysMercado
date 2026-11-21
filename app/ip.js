'use strict';
/* Integração InfinitePay (Checkout: link de pagamento com Pix e cartão).
   Usa a InfiniteTag da loja. A API Key (opcional, começa com inchk_) fica SÓ neste computador.
   Não existe API pública para cancelar link nem para devolver: isso é feito no app da InfinitePay. */
module.exports = function ({ kvGet, kvSet, raw, base }) {
  const BASES = base ? [String(base).replace(/\/$/, '')] : ['https://api.checkout.infinitepay.io', 'https://api.infinitepay.io/invoices/public/checkout'];
  const cfg = () => kvGet('ip') || {};
  const tagOk = t => String(t || '').trim().replace(/^\$/, '').replace(/\s+/g, '').toLowerCase();
  async function req(p, body, c = cfg()) {
    const h = { 'content-type': 'application/json' }; if (c.key) h['X-Api-Key'] = c.key;
    let ult;
    for (const b of BASES) {
      const r = await raw(b + p, { method: 'POST', headers: h, body: JSON.stringify(body) }, 25000);
      const txt = await r.text(); let j = null; try { j = txt ? JSON.parse(txt) : null } catch (e) { }
      if (r.status == 404 && BASES.length > 1) { ult = new Error('InfinitePay: endereço não encontrado'); continue }
      if (!r.ok) {
        const det = j && (j.message || j.error || (j.errors && JSON.stringify(j.errors)));
        const e = new Error(r.status == 403 ? 'InfinitePay recusou: a InfiniteTag e a API Key não são da mesma conta.' : r.status == 401 ? 'InfinitePay recusou a API Key.' : 'InfinitePay: ' + (det || 'erro ' + r.status)); e.status = r.status; throw e;
      }
      return j || {};
    }
    throw ult;
  }
  const cent = v => Math.round((+v || 0) * 100);
  const fone = t => { let d = String(t || '').replace(/\D/g, ''); if (d.length == 10 || d.length == 11) d = '55' + d; return d ? '+' + d : undefined };
  async function linkCriar({ v, ref, titulo, cliente = {}, redirect, webhook, min }, c = cfg()) {
    const tag = tagOk(c.tag); if (!tag && !c.key) throw new Error('InfinitePay não configurada (Gestão > Pagamentos).');
    if (cent(v) < 100) throw new Error('A InfinitePay aceita a partir de R$ 1,00.');
    const body = { ...(tag ? { handle: tag } : {}), order_nsu: String(ref), items: [{ description: String(titulo || 'Pedido').slice(0, 120), price: cent(v), quantity: 1 }],
      ...(redirect ? { redirect_url: redirect } : {}), ...(webhook ? { webhook_url: webhook } : {}),
      customer: { ...(cliente.nome ? { name: String(cliente.nome).slice(0, 80) } : {}), ...(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cliente.email || '') ? { email: cliente.email } : {}), ...(fone(cliente.tel) ? { phone_number: fone(cliente.tel) } : {}) },
      ...(c.key && min ? { options: { single_payment: true, valid_until: new Date(Date.now() + min * 60000).toISOString() } } : {}) };
    const j = await req('/links', body, c);
    const url = j.url || j.payment_url || j.link || (j.data && (j.data.url || j.data.payment_url));
    if (!url) throw new Error('InfinitePay não devolveu o link de pagamento.');
    return { url, slug: j.slug || j.invoice_slug || '' };
  }
  async function conferir({ ref, tnsu, slug }, c = cfg()) {
    const j = await req('/payment_check', { ...(tagOk(c.tag) ? { handle: tagOk(c.tag) } : {}), order_nsu: String(ref), transaction_nsu: String(tnsu || ''), slug: String(slug || '') }, c);
    return { ok: !!j.success, pago: !!(j.success && j.paid), v: (+j.amount || 0) / 100, pagoV: (+j.paid_amount || +j.amount || 0) / 100, parcelas: +j.installments || 1, tipo: /debit/.test(j.capture_method || '') ? 'Débito' : /credit|card/.test(j.capture_method || '') ? 'Crédito' : 'Pix' };
  }
  return { cfg, tagOk, linkCriar, conferir, salvar: c => kvSet('ip', c) };
};
