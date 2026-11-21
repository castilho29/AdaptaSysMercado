# Mercado Online

PDV + Gestão (servidor local no Windows), catálogo/app do cliente, app do entregador e app do parceiro.

## Pastas

```
app/                     o programa (é o que vai para C:\Program Files\MercadoOnline)
  server.js              servidor local (banco SQLite + sincronização com o Supabase)
  fiscal.js              NFC-e / NF-e, DANFE, IBPT
  mp.js  ip.js           Mercado Pago e InfinitePay
  caixa.js impressao.js  modo caixa da rede e impressão térmica
  lib/forge.js           biblioteca do certificado digital (node-forge, num arquivo só)
  lib/municipios.json.gz municípios do IBGE
                         (a tabela IBPT NÃO vai no programa: o sistema baixa a da UF da loja,
                          importa/exporta pelo campo em Configurações > Fiscal, e usa a API)
  public/                telas: pdv.html, gestao.html, configurar.html...
    site/                catálogo (index.html), admin, entregador/, parceiro/
  instalar.bat/.ps1      instalador (usado também pelo .exe)
  atualizar.bat, parar.bat, diagnostico.bat, desinstalar.bat, *.vbs
  supabase.sql           banco online (rodar no SQL Editor do Supabase)
  LEIA-ME.txt            manual da loja
site-assets/             ícones e manifests do site (catálogo, entregador, parceiro)
instalador/              script do Inno Setup que gera o .exe
scripts/montar.js        monta dist/ (programa com manifest.json + site)
scripts/gerar-instalador.bat   gera o .exe no seu PC (opcional)
.github/workflows/       GitHub Actions: gera o .exe sozinho
```

## Gerar o instalador pelo GitHub

1. **Todo push na `main`** gera o instalador. Para baixar: aba **Actions**, abra a execução e veja **Artifacts** (vale 30 dias).
2. **Para lançar uma versão:** crie uma tag começando com `v`. A Release sai com o .exe, o .zip de atualização, o site e o `supabase.sql`.
   ```
   git tag v2026.11.21
   git push origin v2026.11.21
   ```
   Pelo site do GitHub também dá: **Releases > Draft a new release > Choose a tag > v2026.11.21 > Publish**.
3. Para rodar na mão: **Actions > Gerar instalador > Run workflow**.

O que sai:

| Arquivo | Para quê |
|---|---|
| `MercadoOnline-Setup-<versão>.exe` | instala ou atualiza (mantém dados). Já traz o Node.js, não precisa de internet |
| `Mercado-Online-<versão>.zip` | atualização manual: extrair e rodar `atualizar.bat` |
| `catalogo-mercado-online-<versão>.zip` | subir no site (catálogo + entregador + parceiro) |
| `supabase.sql` | rodar no Supabase quando a versão mudar o banco |

A versão é a data e a hora de Brasília (ex.: `2026.11.21-2010`). É ela que aparece no menu da Gestão.

### Site com o config.js pronto (opcional)

Em **Settings > Secrets and variables > Actions > Variables**, crie:
- `SUPABASE_URL`: `https://SEU-PROJETO.supabase.co`
- `SUPABASE_ANON_KEY`: a chave **anon** (pública). **Nunca** a `service_role`; o build recusa se for ela.
- `PRODUTO` (opcional): nome que aparece no app.

Sem essas variáveis, o zip do site sai sem `config.js`. Nesse caso use o da Gestão > "Baixar site", que já vem configurado.

## O que NÃO vai para o Git

O `.gitignore` já bloqueia:
- `dados/`: banco, vendas, `config.json`;
- certificado `.pfx`;
- tokens;
- `node/`, `navegador/`, `dist/` e `build/`.

Os tokens do Mercado Pago, da InfinitePay e do IBPT ficam só no banco local de cada loja. Eles nunca ficam no código.

Recomendado: deixe o repositório **privado**.

## Gerar no seu PC (sem GitHub)

Precisa do Node.js 22 e do [Inno Setup 6](https://jrsoftware.org/isdl.php). Depois rode `scripts\gerar-instalador.bat`.

Nesse caso o .exe sai sem o Node.js embutido: o instalador baixa o Node.js na primeira instalação.
