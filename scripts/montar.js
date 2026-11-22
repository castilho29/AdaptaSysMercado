#!/usr/bin/env node
/*
 * Monta a pasta de distribuição a partir do código do repositório.
 *
 *   node scripts/montar.js
 *
 * Gera:
 *   dist/AdaptaSysMercado/   programa pronto (com manifest.json: versão + SHA-256 de cada arquivo)
 *   dist/site/            catálogo + app do entregador + app do parceiro (para subir no site)
 *   dist/versao.txt       a versão gerada
 *
 * Variáveis opcionais:
 *   VERSAO            força a versão (padrão: data/hora de Brasília, ex. 2026.11.21-2010)
 *   SUPABASE_URL      URL do Supabase da loja  -> vira dist/site/config.js
 *   SUPABASE_ANON_KEY chave PÚBLICA "anon" (nunca a service_role)
 *   PRODUTO           nome do produto no config.js (padrão "AdaptaSys Mercado")
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const APP = path.join(RAIZ, 'app');
const ASSETS = path.join(RAIZ, 'site-assets');
const DIST = path.join(RAIZ, 'dist');
const PROG = path.join(DIST, 'AdaptaSysMercado');
const SITE = path.join(DIST, 'site');

const PULA_DIR = new Set(['dados', 'node', 'node_modules', 'navegador']);
const PULA_ARQ = new Set(['manifest.json', 'instalado.txt']);

function versaoAgora() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}.${p.month}.${p.day}-${p.hour}${p.minute}`;
}

function listar(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (PULA_DIR.has(e.name) || e.name.startsWith('dados')) continue;
      out.push(...listar(abs, base));
    } else if (e.isFile()) {
      if (PULA_ARQ.has(e.name) || e.name.endsWith('.log')) continue;
      out.push(path.relative(base, abs).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

function copiar(de, para) { fs.mkdirSync(path.dirname(para), { recursive: true }); fs.copyFileSync(de, para); }
function copiarPasta(de, para) { for (const f of listar(de)) copiar(path.join(de, f), path.join(para, f)); }

// 1) confere a sintaxe dos .js do servidor antes de montar
for (const f of listar(APP).filter(f => f.endsWith('.js') && !f.startsWith('lib/') && !f.startsWith('public/'))) {
  execFileSync(process.execPath, ['--check', path.join(APP, f)], { stdio: 'inherit' });
}

// 2) programa
const versao = (process.env.VERSAO || '').trim() || versaoAgora();
fs.rmSync(DIST, { recursive: true, force: true });
const arquivos = listar(APP);
for (const f of arquivos) copiar(path.join(APP, f), path.join(PROG, f));
const manifest = { versao, arquivos: {} };
for (const f of arquivos) manifest.arquivos[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(PROG, f))).digest('hex');
fs.writeFileSync(path.join(PROG, 'manifest.json'), JSON.stringify(manifest, null, 0));

// 3) site (catálogo / entregador / parceiro)
copiarPasta(path.join(APP, 'public', 'site'), SITE);
copiarPasta(ASSETS, SITE);
const url = (process.env.SUPABASE_URL || '').trim(), key = (process.env.SUPABASE_ANON_KEY || '').trim();
if (url && key) {
  if (/service_role/.test(Buffer.from((key.split('.')[1] || ''), 'base64').toString())) {
    console.error('ERRO: SUPABASE_ANON_KEY é uma chave service_role. Use só a chave pública "anon".'); process.exit(1);
  }
  const produto = (process.env.PRODUTO || 'AdaptaSys Mercado').replace(/'/g, '');
  fs.writeFileSync(path.join(SITE, 'config.js'),
    `/* AdaptaSys Mercado · configuração do catálogo (Supabase da loja; chave pública "anon") */\nwindow.MO_CFG = {\n  sbUrl: '${url}',\n  sbKey: '${key}',\n  fakeDom: '',\n  produto: '${produto}'\n};\n`);
} else {
  console.log('Aviso: sem SUPABASE_URL/SUPABASE_ANON_KEY -> o site sai sem config.js (gere pela Gestão > "Baixar site").');
}

fs.writeFileSync(path.join(DIST, 'versao.txt'), versao);
if (process.env.GITHUB_ENV) fs.appendFileSync(process.env.GITHUB_ENV, `VERSAO=${versao}\n`);
console.log(`Versão ${versao}: ${arquivos.length} arquivos do programa, ${listar(SITE).length} do site.`);
