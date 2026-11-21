-- =====================================================================
-- MERCADO ONLINE · banco online da empresa (Supabase)
-- Rode este arquivo INTEIRO no SQL Editor do Supabase do mercado.
-- Pode rodar de novo a cada atualização: tudo aqui é seguro para repetir.
-- Cada empresa tem o seu próprio projeto Supabase (dados totalmente separados).
-- =====================================================================

-- =====================================================================
-- FASE 0: BASE (só cria o que ainda não existe; não mexe num banco já em uso)
-- =====================================================================
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  criado timestamptz default now()
);
alter table public.admins enable row level security;   -- sem políticas: ninguém lê/edita pela API

do $$
begin
  -- "sou administrador da loja?" (só cria se o banco ainda não tiver a sua própria)
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'sou_admin' and p.pronargs = 0) then
    execute $f$
      create function public.sou_admin() returns boolean
      language sql stable security definer set search_path to 'public' as
      $b$ select exists (select 1 from public.admins where user_id = auth.uid()) $b$ $f$;
    execute 'grant execute on function public.sou_admin() to anon, authenticated';
  end if;
end $$;

do $$
declare t text; novo boolean;
begin
  foreach t in array array['products','clients','orders','config','caixa'] loop
    novo := to_regclass('public.' || t) is null;
    execute format('create table if not exists public.%I (id text primary key, data jsonb not null, updated_at timestamptz default now())', t);
    if novo then
      execute format('alter table public.%I enable row level security', t);
      execute format('create policy "admin %s" on public.%I for all to authenticated using (sou_admin()) with check (sou_admin())', t, t);
      if t in ('products','config') then      -- catálogo do app: qualquer pessoa vê produtos e dados da loja
        execute format('create policy "ver %s" on public.%I for select to anon, authenticated using (true)', t, t);
      elsif t = 'clients' then                -- o cliente vê e edita só o próprio cadastro
        execute 'create policy "cliente ve o seu" on public.clients for select to authenticated using (id = auth.uid()::text)';
        execute 'create policy "cliente cria o seu" on public.clients for insert to authenticated with check (id = auth.uid()::text)';
        execute 'create policy "cliente edita o seu" on public.clients for update to authenticated using (id = auth.uid()::text) with check (id = auth.uid()::text)';
      elsif t = 'orders' then                 -- o cliente vê só os próprios pedidos (cria pela função criar_pedido)
        execute 'create policy "cliente ve os seus" on public.orders for select to authenticated using (data->>''cid'' = auth.uid()::text)';
      end if;
    end if;
  end loop;
end $$;

-- Fatura uma venda do balcão (pedido novo) OU um pedido do catálogo (já existe).
-- * Só administradores podem chamar.
-- * Estoque: baixa a diferença entre os itens novos e os itens que o pedido já tinha
--   (pedido do catálogo já baixou estoque ao ser criado; se o caixa tirou ou
--   acrescentou itens, só a diferença mexe no estoque).
-- * Idempotente: se o PDV reenviar o mesmo faturamento (fila offline), não baixa de novo.
create or replace function public.pdv_faturar(p_id text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  old jsonb;
  r record;
  fid text := p_data->'fat'->>'id';
  novo jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja pode faturar'; end if;
  if p_id is null or fid is null then raise exception 'Faturamento inválido'; end if;
  if jsonb_array_length(coalesce(p_data->'items','[]'::jsonb)) = 0 then raise exception 'Venda sem itens'; end if;

  select data into old from orders where id = p_id for update;

  -- reenvio do mesmo faturamento: não faz nada
  if old is not null and old->'fat'->>'id' = fid then return old; end if;
  if old is not null and old ? 'fat' then raise exception 'Este pedido já foi faturado'; end if;
  if old is not null and old->>'st' = 'canc' then raise exception 'Pedido cancelado não pode ser faturado'; end if;

  -- estoque pela diferença (itens novos - itens antigos)
  for r in
    with n as (
      select it->>'pid' pid, sum((it->>'q')::numeric) q
      from jsonb_array_elements(p_data->'items') it
      where it->>'pid' is not null group by 1),
    o as (
      select it->>'pid' pid, sum((it->>'q')::numeric) q
      from jsonb_array_elements(coalesce(old->'items','[]'::jsonb)) it
      where it->>'pid' is not null group by 1)
    select coalesce(n.pid, o.pid) pid, coalesce(n.q,0) - coalesce(o.q,0) d
    from n full join o on n.pid = o.pid
  loop
    if r.d <> 0 then
      update products
        set data = jsonb_set(data, '{est}', to_jsonb(greatest(0, (data->>'est')::numeric - r.d))),
            updated_at = now()
        where id = r.pid and nullif(data->>'est','') is not null;
    end if;
  end loop;

  if old is null then
    novo := p_data || jsonb_build_object('id', p_id);
    insert into orders (id, data, updated_at) values (p_id, novo, now());
  else
    -- mantém dados do cliente do catálogo e aplica o que veio do caixa
    novo := old || p_data || jsonb_build_object('id', p_id, 'cid', old->'cid', 'canal', coalesce(old->>'canal','app'));
    update orders set data = novo, updated_at = now() where id = p_id;
  end if;
  return novo;
end $$;

revoke all on function public.pdv_faturar(text, jsonb) from public, anon;
grant execute on function public.pdv_faturar(text, jsonb) to authenticated;

-- =====================================================================
-- SINCRONIZAÇÃO DO SERVIDOR LOCAL DO CAIXA
-- O servidor local busca só o que mudou, pela coluna updated_at.
-- Este gatilho garante que toda gravação (app, painel, PDV) atualize a data.
-- =====================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

do $$
declare t text;
begin
  foreach t in array array['products','clients','orders','caixa','config'] loop
    execute format('alter table public.%I add column if not exists updated_at timestamptz default now()', t);
    execute format('drop trigger if exists trg_touch_updated_at on public.%I', t);
    execute format('create trigger trg_touch_updated_at before insert or update on public.%I for each row execute function public.touch_updated_at()', t);
    execute format('create index if not exists %I on public.%I (updated_at)', t || '_updated_at_idx', t);
  end loop;
end $$;

-- =====================================================================
-- PEDIDO DO APP CALCULADO NO SERVIDOR (preço, taxa e total conferidos)
-- =====================================================================
-- Horário de atendimento do app (config 'empresa' -> hor). Mesma regra do catálogo (horSt).
-- hor = {on, tz, antes (min antes de fechar), pausa, d: {"0".."6": [["07:00","12:00"],["14:00","20:00"]]}}
create or replace function public.loja_aberta(h jsonb)
returns boolean language plpgsql stable set search_path to 'public' as $$
declare
  tz text := coalesce(nullif(h->>'tz',''),'America/Sao_Paulo');
  agora timestamp; dw int; m int; antes int := coalesce(nullif(h->>'antes','')::int,0);
  iv jsonb; i int; f int;
begin
  if h is null then return true; end if;
  if coalesce((h->>'pausa')::boolean,false) then return false; end if;
  if not coalesce((h->>'on')::boolean,false) then return true; end if;
  begin agora := now() at time zone tz; exception when others then agora := now() at time zone 'America/Sao_Paulo'; end;
  dw := extract(dow from agora)::int; m := extract(hour from agora)::int*60 + extract(minute from agora)::int;
  for iv in select * from jsonb_array_elements(coalesce(h->'d'->(dw::text),'[]'::jsonb)) loop
    continue when coalesce(iv->>0,'')='' or coalesce(iv->>1,'')='';
    i := split_part(iv->>0,':',1)::int*60 + coalesce(nullif(split_part(iv->>0,':',2),''),'0')::int;
    f := split_part(iv->>1,':',1)::int*60 + coalesce(nullif(split_part(iv->>1,':',2),''),'0')::int;
    if f > i and m >= i and m < f - antes then return true; end if;
    if f <= i and m >= i and (1440 - m) + f > antes then return true; end if;
  end loop;
  for iv in select * from jsonb_array_elements(coalesce(h->'d'->(((dw+6)%7)::text),'[]'::jsonb)) loop
    continue when coalesce(iv->>0,'')='' or coalesce(iv->>1,'')='';
    i := split_part(iv->>0,':',1)::int*60 + coalesce(nullif(split_part(iv->>0,':',2),''),'0')::int;
    f := split_part(iv->>1,':',1)::int*60 + coalesce(nullif(split_part(iv->>1,':',2),''),'0')::int;
    if f <= i and m < f - antes then return true; end if;
  end loop;
  return false;
end $$;
grant execute on function public.loja_aberta(jsonb) to anon, authenticated;

drop function if exists public.criar_pedido(text, jsonb);

create function public.criar_pedido(p_id text, p_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  uid text := auth.uid()::text;
  cli jsonb; cfg jsonb; prod jsonb; r record;
  estq numeric; pad numeric; tem_taxa boolean;
  itens jsonb := '[]'::jsonb;
  sub numeric := 0; taxa numeric := 0; tot numeric; cash numeric := 0;
  ent text := coalesce(p_data->>'ent','entrega');
  bairro text := coalesce(p_data->>'bairro','');
  pay text := coalesce(p_data->>'pay','');
  gw text := coalesce(nullif(p_data->>'gw',''),'mp');
  o jsonb; parts jsonb := '{}'::jsonb; pr record;
begin
  if uid is null then raise exception 'Faça login para pedir'; end if;
  if not loja_aberta((select data->'hor' from config where id = 'empresa')) then raise exception 'FECHADO: a loja não está recebendo pedidos agora'; end if;
  if p_id is null or length(p_id) < 8 or length(p_id) > 64 then raise exception 'Pedido inválido'; end if;
  if pay not in ('Dinheiro','Pix','Cartão','Online') then raise exception 'Forma de pagamento inválida'; end if;
  if pay = 'Online' then
    if gw not in ('mp','ip') then raise exception 'Forma de pagamento inválida'; end if;
    if coalesce((select data->>(case gw when 'ip' then 'ipApp' else 'mpApp' end) from config where id = 'empresa'),'false') <> 'true' then raise exception 'Essa forma de pagamento pelo app não está ligada nesta loja'; end if;
  end if;
  if ent not in ('entrega','retirada') then raise exception 'Pedido inválido'; end if;
  if ent = 'entrega' and coalesce(trim(p_data->>'addr'),'') = '' then raise exception 'Informe o endereço de entrega'; end if;

  select data into cli from clients where id = uid;
  if cli is null then raise exception 'Complete seu cadastro antes de pedir'; end if;

  for r in
    select it->>'pid' as pid, sum((it->>'q')::numeric) as q
    from jsonb_array_elements(coalesce(p_data->'items','[]'::jsonb)) it
    where it->>'pid' is not null
    group by it->>'pid'
  loop
    if r.q is null or r.q <= 0 or r.q > 999 then raise exception 'Quantidade inválida'; end if;
    select data into prod from products where id = r.pid for update;
    if prod is null then raise exception 'ESTOQUE:um produto que saiu do catálogo'; end if;
    estq := nullif(prod->>'est','')::numeric;
    if estq is not null and estq < r.q then raise exception 'ESTOQUE:%', prod->>'n'; end if;
    if estq is not null then
      update products set data = jsonb_set(data,'{est}',to_jsonb(estq - r.q)), updated_at = now() where id = r.pid;
    end if;
    -- produto com "Estoque: Parceiro X": o item leva o parceiro e a parte dele vai para a tela do parceiro
    if coalesce(prod->>'parc','') <> '' then
      select id, nome, endereco, loc, fone, entrega into pr from parceiros where id::text = prod->>'parc' and ativo;
      if pr.id is null then raise exception 'ESTOQUE:%', prod->>'n'; end if;
      if not (parts ? pr.id::text) then
        parts := parts || jsonb_build_object(pr.id::text, jsonb_build_object('nome',pr.nome,'endereco',pr.endereco,'loc',pr.loc,'fone',pr.fone,'entrega',pr.entrega,'st','novo'));
      end if;
      itens := itens || jsonb_build_object('pid',r.pid,'n',prod->>'n','u',coalesce(prod->>'u','un'),'p',(prod->>'p')::numeric,'q',r.q,'parc',pr.id::text);
    else
      itens := itens || jsonb_build_object('pid',r.pid,'n',prod->>'n','u',coalesce(prod->>'u','un'),'p',(prod->>'p')::numeric,'q',r.q);
    end if;
    sub := sub + round((prod->>'p')::numeric * r.q, 2);
  end loop;
  if jsonb_array_length(itens) = 0 then raise exception 'Carrinho vazio'; end if;

  select data into cfg from config where id = 'empresa';
  pad := case when coalesce(cfg->>'taxaPad','') ~ '^[0-9]+(\.[0-9]+)?$' then (cfg->>'taxaPad')::numeric end;
  tem_taxa := jsonb_array_length(coalesce(cfg->'taxas','[]'::jsonb)) > 0 or pad is not null;
  if ent = 'entrega' and tem_taxa then
    if bairro = 'Outros bairros' and pad is not null then
      taxa := pad;
    else
      select (t->>'v')::numeric into taxa
      from jsonb_array_elements(coalesce(cfg->'taxas','[]'::jsonb)) t
      where upper(trim(t->>'b')) = upper(trim(bairro)) limit 1;
      if not found then raise exception 'Escolha o bairro da entrega'; end if;
    end if;
  end if;
  taxa := round(coalesce(taxa,0), 2);
  tot := round(sub + taxa, 2);

  if pay = 'Dinheiro' then cash := coalesce(nullif(p_data->>'cash','')::numeric, 0); end if;
  if cash > 0 and cash < tot then raise exception 'O valor para troco é menor que o total'; end if;

  o := jsonb_build_object(
    'id',p_id,'cid',uid,
    'date',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cn',cli->>'n','ph',cli->>'t',
    'addr',case when ent='retirada' then 'Retirada na loja' else left(trim(p_data->>'addr'),300) end,
    'loc',p_data->'loc',
    'items',itens,'sub',sub,'taxa',taxa,'total',tot,
    'bairro',case when ent='entrega' and tem_taxa then bairro else '' end,
    'ent',ent,'pay',pay,'cash',cash,'troco',case when cash > 0 then cash - tot else 0 end,
    'obs',left(coalesce(p_data->>'obs',''),300),
    'ref',left(coalesce(cli->>'ref',''),300),
    'done',false,'st',case when pay = 'Online' then 'pagar' else 'novo' end,'canal','app')
    || case when pay = 'Online' then jsonb_build_object('gw', gw) else '{}'::jsonb end
    || case when parts <> '{}'::jsonb then jsonb_build_object('parts', parts) else '{}'::jsonb end;

  insert into orders (id, data, updated_at) values (p_id, o, now());
  return o;
end $$;

revoke all on function public.criar_pedido(text, jsonb) from public, anon;
grant execute on function public.criar_pedido(text, jsonb) to authenticated;

-- =====================================================================
-- FASE 2: OPERADORES, ESTOQUE, FIADO E CANCELAMENTO DE VENDA
-- (pode rodar o arquivo inteiro de novo: tudo aqui é seguro para repetir)
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['operadores','mov_estoque','fiado'] loop
    execute format('create table if not exists public.%I (id text primary key, data jsonb not null, updated_at timestamptz default now())', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin %s" on public.%I', t, t);
    execute format('create policy "admin %s" on public.%I for all to authenticated using (sou_admin()) with check (sou_admin())', t, t);
    execute format('drop trigger if exists trg_touch_updated_at on public.%I', t);
    execute format('create trigger trg_touch_updated_at before insert or update on public.%I for each row execute function public.touch_updated_at()', t);
    execute format('create index if not exists %I on public.%I (updated_at)', t || '_updated_at_idx', t);
  end loop;
end $$;

-- grava/atualiza (mesclando) clientes, operadores e lançamentos de fiado vindos do caixa
create or replace function public.pdv_merge(p_tab text, p_id text, p_data jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if p_tab not in ('clients','operadores','fiado') then raise exception 'Tabela não permitida'; end if;
  execute format('insert into public.%I (id, data, updated_at) values ($1, $2, now())
                  on conflict (id) do update set data = public.%I.data || excluded.data, updated_at = now()', p_tab, p_tab)
    using p_id, p_data;
end $$;

-- produto cadastrado/alterado no caixa: nunca mexe no estoque nem na foto de um produto que já existe
create or replace function public.pdv_salvar_produto(p_id text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare old jsonb; novo jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  select data into old from products where id = p_id for update;
  if old is null then
    novo := p_data || jsonb_build_object('id', p_id);
    insert into products (id, data, updated_at) values (p_id, novo, now());
  else
    novo := old || (p_data - 'est' - 'img' - 'id');
    update products set data = novo, updated_at = now() where id = p_id;
  end if;
  return novo;
end $$;

-- movimento de estoque (entrada, ajuste, perda, inventário): aplica a diferença e guarda o histórico
create or replace function public.pdv_mov_estoque(p_mov jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
declare mid text := p_mov->>'id'; pid text := p_mov->>'pid'; d numeric := coalesce((p_mov->>'q')::numeric, 0); pd jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if mid is null then raise exception 'Movimento inválido'; end if;
  if exists (select 1 from mov_estoque where id = mid) then return; end if;
  insert into mov_estoque (id, data, updated_at) values (mid, p_mov, now());
  select data into pd from products where id = pid for update;
  if pd is null then return; end if;
  pd := jsonb_set(pd, '{est}', to_jsonb(greatest(0, coalesce(nullif(pd->>'est','')::numeric, 0) + d)));
  if coalesce((p_mov->>'custo')::numeric, 0) > 0 then pd := pd || jsonb_build_object('custo', (p_mov->>'custo')::numeric); end if;
  update products set data = pd, updated_at = now() where id = pid;
end $$;

-- cancelamento de venda feito no caixa: devolve o estoque uma única vez
create or replace function public.pdv_estornar(p_id text, p_canc jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare old jsonb; it jsonb; novo jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  select data into old from orders where id = p_id for update;
  if old is null then raise exception 'Venda não encontrada no sistema online'; end if;
  if old->>'st' = 'canc' then return old; end if;
  if coalesce((old->>'rest')::boolean, false) = false then
    for it in select * from jsonb_array_elements(coalesce(old->'items','[]'::jsonb)) loop
      if it->>'pid' is not null then
        update products
          set data = jsonb_set(data, '{est}', to_jsonb((data->>'est')::numeric + coalesce((it->>'q')::numeric, 0))), updated_at = now()
          where id = it->>'pid' and nullif(data->>'est','') is not null;
      end if;
    end loop;
  end if;
  novo := old || jsonb_build_object('st','canc','done',false,'rest',true,'canc',p_canc);
  update orders set data = novo, updated_at = now() where id = p_id;
  return novo;
end $$;

revoke all on function public.pdv_merge(text, text, jsonb) from public, anon;
revoke all on function public.pdv_salvar_produto(text, jsonb) from public, anon;
revoke all on function public.pdv_mov_estoque(jsonb) from public, anon;
revoke all on function public.pdv_estornar(text, jsonb) from public, anon;
grant execute on function public.pdv_merge(text, text, jsonb) to authenticated;
grant execute on function public.pdv_salvar_produto(text, jsonb) to authenticated;
grant execute on function public.pdv_mov_estoque(jsonb) to authenticated;
grant execute on function public.pdv_estornar(text, jsonb) to authenticated;

-- =====================================================================
-- FASE 3: GESTÃO SUBSTITUI O PAINEL ONLINE
-- (status de pedido do app, ajustes da loja e foto de produto vindos do caixa)
-- =====================================================================
create or replace function public.pdv_merge(p_tab text, p_id text, p_data jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if p_tab not in ('clients','operadores','fiado','config') then raise exception 'Tabela não permitida'; end if;
  execute format('insert into public.%I (id, data, updated_at) values ($1, $2, now())
                  on conflict (id) do update set data = public.%I.data || excluded.data, updated_at = now()', p_tab, p_tab)
    using p_id, p_data;
end $$;

-- agora a foto enviada pela Gestão também é gravada (o estoque continua protegido)
create or replace function public.pdv_salvar_produto(p_id text, p_data jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare old jsonb; novo jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  select data into old from products where id = p_id for update;
  if old is null then
    novo := p_data || jsonb_build_object('id', p_id);
    insert into products (id, data, updated_at) values (p_id, novo, now());
  else
    novo := old || (p_data - 'est' - 'id');
    update products set data = novo, updated_at = now() where id = p_id;
  end if;
  return novo;
end $$;

-- confirmar / entregar / reabrir pedido do app a partir da Gestão
create or replace function public.pdv_pedido_status(p_id text, p_st text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare old jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if p_st not in ('novo','conf','ent') then raise exception 'Situação inválida'; end if;
  select data into old from orders where id = p_id for update;
  if old is null then raise exception 'Pedido não encontrado no sistema online'; end if;
  if old->>'st' = 'canc' then return; end if;
  update orders set data = old || jsonb_build_object('st', p_st, 'done', p_st = 'ent'), updated_at = now() where id = p_id;
end $$;

revoke all on function public.pdv_pedido_status(text, text) from public, anon;
grant execute on function public.pdv_pedido_status(text, text) to authenticated;

-- fase 4: excluir pedido CANCELADO (o estoque já foi devolvido no cancelamento).
-- Só apaga se estiver cancelado, com estoque devolvido e sem faturamento (venda faturada fica no histórico).
create or replace function public.pdv_excluir_pedido(p_id text)
returns void language plpgsql security definer set search_path to 'public' as $$
declare old jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  select data into old from orders where id = p_id for update;
  if old is null then return; end if;
  if coalesce(old->>'st','') <> 'canc' or coalesce((old->>'rest')::boolean,false) = false or old ? 'fat' then
    raise exception 'Só pedido cancelado (e não faturado) pode ser excluído';
  end if;
  delete from orders where id = p_id;
end $$;
revoke all on function public.pdv_excluir_pedido(text) from public, anon;
grant execute on function public.pdv_excluir_pedido(text) to authenticated;

-- =====================================================================
-- FASE 5: CONTAS A PAGAR E VALIDADE DOS PRODUTOS (lotes)
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array['contas','lotes'] loop
    execute format('create table if not exists public.%I (id text primary key, data jsonb not null, updated_at timestamptz default now())', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "admin %s" on public.%I', t, t);
    execute format('create policy "admin %s" on public.%I for all to authenticated using (sou_admin()) with check (sou_admin())', t, t);
    execute format('drop trigger if exists trg_touch_updated_at on public.%I', t);
    execute format('create trigger trg_touch_updated_at before insert or update on public.%I for each row execute function public.touch_updated_at()', t);
    execute format('create index if not exists %I on public.%I (updated_at)', t || '_updated_at_idx', t);
  end loop;
end $$;

create or replace function public.pdv_merge(p_tab text, p_id text, p_data jsonb)
returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if p_tab not in ('clients','operadores','fiado','config','contas','lotes') then raise exception 'Tabela não permitida'; end if;
  execute format('insert into public.%I (id, data, updated_at) values ($1, $2, now())
                  on conflict (id) do update set data = public.%I.data || excluded.data, updated_at = now()', p_tab, p_tab)
    using p_id, p_data;
end $$;
revoke all on function public.pdv_merge(text, text, jsonb) from public, anon;
grant execute on function public.pdv_merge(text, text, jsonb) to authenticated;


-- =====================================================================
-- FASE 6: ENTREGADORES (tela do entregador no celular) e SUGESTÃO DE ENDEREÇO
-- O entregador entra com um código gerado na Gestão (sem senha). Ele só enxerga
-- os pedidos aceitos para entrega, por funções abaixo (nada de acesso direto às tabelas).
-- =====================================================================
create table if not exists public.entregadores (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  codigo text,
  codigo_exp timestamptz,
  user_id uuid unique,
  ativo boolean default true,
  criado timestamptz default now(),
  ultimo timestamptz
);
alter table public.entregadores enable row level security;   -- sem políticas: só pelas funções

create or replace function public.ent_codigo() returns text language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random()*32)::int, 1), '') from generate_series(1,8) $$;

create or replace function public.sou_entregador() returns uuid
language sql stable security definer set search_path to 'public' as $$
  select id from entregadores where user_id = auth.uid() and ativo $$;

create or replace function public.listar_entregadores() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'nome',e.nome,'pareado',e.user_id is not null,'ultimo',e.ultimo,
    'codigo',case when e.codigo_exp > now() then e.codigo end,'exp',e.codigo_exp,'valor',e.valor,'modo',e.modo) || entregador_numeros(e.id) order by e.nome)
    from entregadores e where e.ativo),'[]'::jsonb);
end $$;

create or replace function public.criar_entregador(p_nome text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r entregadores;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if coalesce(trim(p_nome),'') = '' then raise exception 'Informe o nome do entregador'; end if;
  insert into entregadores(nome,codigo,codigo_exp) values (left(trim(p_nome),60), ent_codigo(), now() + interval '24 hours') returning * into r;
  return jsonb_build_object('id',r.id,'nome',r.nome,'codigo',r.codigo,'exp',r.codigo_exp);
end $$;

create or replace function public.novo_codigo_entregador(p_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r entregadores;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  update entregadores set codigo = ent_codigo(), codigo_exp = now() + interval '24 hours', user_id = null where id = p_id and ativo returning * into r;
  if r.id is null then raise exception 'Entregador não encontrado'; end if;
  return jsonb_build_object('id',r.id,'nome',r.nome,'codigo',r.codigo,'exp',r.codigo_exp);
end $$;

create or replace function public.remover_entregador(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  update entregadores set ativo = false, user_id = null, codigo = null where id = p_id;
end $$;

-- o celular do entregador usa o código (uma vez) e fica ligado a ele
create or replace function public.entregador_parear(p_codigo text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r entregadores; c text := upper(regexp_replace(coalesce(p_codigo,''),'[^A-Za-z0-9]','','g'));
begin
  if auth.uid() is null then raise exception 'Abra pelo link do entregador'; end if;
  if length(c) <> 8 then raise exception 'Código inválido'; end if;
  select * into r from entregadores where codigo = c and codigo_exp > now() and ativo for update;
  if r.id is null then raise exception 'Código inválido ou vencido. Peça um novo na loja.'; end if;
  update entregadores set user_id = null where user_id = auth.uid() and id <> r.id;
  update entregadores set user_id = auth.uid(), codigo = null, codigo_exp = null, ultimo = now() where id = r.id;
  return jsonb_build_object('id',r.id,'nome',r.nome);
end $$;

create or replace function public.entregador_eu() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r entregadores; cfg jsonb;
begin
  select * into r from entregadores where user_id = auth.uid() and ativo;
  if r.id is null then return null; end if;
  update entregadores set ultimo = now() where id = r.id;
  select data into cfg from config where id = 'empresa';
  return jsonb_build_object('id',r.id,'nome',r.nome,'loja',cfg->>'n','tel',cfg->>'tel','logo',cfg->>'logo');
end $$;

-- pedidos aceitos para entrega (dos últimos 2 dias) + os que ele entregou hoje
create or replace function public.entregador_pedidos() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare eid uuid := sou_entregador();
begin
  if eid is null then raise exception 'ENTREGADOR: este celular não está liberado'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id',o.id,'date',o.data->>'date','st',o.data->>'st','cn',o.data->>'cn','ph',o.data->>'ph',
      'addr',o.data->>'addr','bairro',coalesce(nullif(o.data->>'bairro',''),c.data->>'bai'),'ref',coalesce(nullif(o.data->>'ref',''),c.data->>'ref'),'obs',o.data->>'obs',
      'loc',coalesce(o.data->'loc',c.data->'loc'),'pay',o.data->>'pay','total',o.data->'total','taxa',o.data->'taxa','cash',o.data->'cash','troco',o.data->'troco',
      'pags',o.data->'fat'->'pags','fat',(o.data ? 'fat'),'itens',jsonb_array_length(coalesce(o.data->'items','[]'::jsonb)),'items',o.data->'items',
      'rota',o.data->'rota','entregue',o.data->'entregue','parts',o.data->'parts') order by o.data->>'date')
    from orders o left join clients c on c.id = o.data->>'cid'
    where coalesce(o.data->>'ent','entrega') <> 'retirada'
      and ((o.data->>'st' = 'conf' and o.updated_at > now() - interval '2 days')
        or (o.data->>'st' = 'ent' and (o.data->'entregue'->>'id') = eid::text and o.updated_at > now() - interval '20 hours'))),'[]'::jsonb);
end $$;

create or replace function public.entregador_pegar(p_id text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare eid uuid := sou_entregador(); nm text; old jsonb;
begin
  if eid is null then raise exception 'ENTREGADOR: este celular não está liberado'; end if;
  select nome into nm from entregadores where id = eid;
  select data into old from orders where id = p_id for update;
  if old is null or old->>'st' <> 'conf' then raise exception 'Este pedido não está mais esperando entrega'; end if;
  if old->'rota' is not null and old->'rota'->>'id' <> eid::text then raise exception 'Este pedido já está com %', old->'rota'->>'nome'; end if;
  update orders set data = old || jsonb_build_object('rota', jsonb_build_object('id',eid,'nome',nm,'date',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'))), updated_at = now() where id = p_id;
  return jsonb_build_object('ok',true);
end $$;

create or replace function public.entregador_soltar(p_id text) returns void
language plpgsql security definer set search_path to 'public' as $$
declare eid uuid := sou_entregador(); old jsonb;
begin
  if eid is null then raise exception 'ENTREGADOR: este celular não está liberado'; end if;
  select data into old from orders where id = p_id for update;
  if old->'rota'->>'id' = eid::text and old->>'st' = 'conf' then update orders set data = old - 'rota', updated_at = now() where id = p_id; end if;
end $$;

create or replace function public.entregador_entregue(p_id text, p_loc jsonb default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare eid uuid := sou_entregador(); nm text; old jsonb; vl numeric;
begin
  if eid is null then raise exception 'ENTREGADOR: este celular não está liberado'; end if;
  select nome into nm from entregadores where id = eid;
  select data into old from orders where id = p_id for update;
  if old is null then raise exception 'Pedido não encontrado'; end if;
  if old->>'st' = 'ent' then return jsonb_build_object('ok',true,'ja',true); end if;
  if old->>'st' <> 'conf' then raise exception 'Este pedido foi cancelado ou ainda não foi aceito pela loja'; end if;
  if old->'rota' is not null and old->'rota'->>'id' <> eid::text then raise exception 'Este pedido está com %', old->'rota'->>'nome'; end if;
  select case when e.modo = 'taxa' then coalesce(nullif(old->>'taxa','')::numeric,0) else coalesce(e.valor,0) end into vl from entregadores e where e.id = eid;
  update orders set data = old || jsonb_build_object('st','ent','done',true,
      'entregue', jsonb_build_object('id',eid,'por',nm,'date',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),'loc',p_loc,'valor',round(coalesce(vl,0),2))),
    updated_at = now() where id = p_id;
  return jsonb_build_object('ok',true);
end $$;

-- sugestão de rua e bairro pelos vizinhos que já confirmaram o endereço no mapa
-- (devolve só o nome da rua e do bairro mais próximos; nenhum dado pessoal)
create or replace function public.sugerir_endereco(p_lat double precision, p_lng double precision) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare r record; rua text; rd double precision; bai text; bd double precision;
begin
  if auth.uid() is null or p_lat is null or p_lng is null then return null; end if;
  for r in
    select data->>'rua' as rua, data->>'bai' as bai,
      111320 * sqrt(power((data->'loc'->>'lat')::float8 - p_lat, 2) + power(((data->'loc'->>'lng')::float8 - p_lng) * cos(radians(p_lat)), 2)) as d
    from clients
    where id <> auth.uid()::text and coalesce(data->'loc'->>'ok','') = 'true'
      and abs((data->'loc'->>'lat')::float8 - p_lat) < 0.006 and abs((data->'loc'->>'lng')::float8 - p_lng) < 0.006
    order by d limit 12
  loop
    if rua is null and coalesce(r.rua,'') <> '' and r.d <= 70 then rua := r.rua; rd := r.d; end if;
    if bai is null and coalesce(r.bai,'') <> '' and r.d <= 450 then bai := r.bai; bd := r.d; end if;
  end loop;
  return jsonb_build_object('rua',rua,'rua_m',round(rd),'bai',bai,'bai_m',round(bd));
end $$;

do $$ declare f text; begin
  foreach f in array array['listar_entregadores()','criar_entregador(text)','novo_codigo_entregador(uuid)','remover_entregador(uuid)','entregador_parear(text)','entregador_eu()',
    'entregador_pedidos()','entregador_pegar(text)','entregador_soltar(text)','entregador_entregue(text,jsonb)','sugerir_endereco(double precision,double precision)','sou_entregador()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;


-- =====================================================================
-- FASE 7: GANHOS DO ENTREGADOR (valor por entrega, entregas do dia/mês, pagamentos e saldo)
-- =====================================================================
alter table public.entregadores add column if not exists valor numeric(10,2) default 0;
alter table public.entregadores add column if not exists modo text default 'fixo';      -- 'fixo' = valor por entrega; 'taxa' = a taxa de entrega do pedido
create table if not exists public.pagamentos_entregador (
  id uuid primary key default gen_random_uuid(),
  entregador_id uuid not null references public.entregadores(id),
  valor numeric(10,2) not null,
  obs text default '',
  por text default '',
  data timestamptz default now()
);
alter table public.pagamentos_entregador enable row level security;   -- só pelas funções

-- valor de uma entrega: o gravado na hora; se ficou sem valor (ou R$ 0, antes de configurar), usa o configurado agora
create or replace function public.valor_entrega(o jsonb, p_eid uuid) returns numeric
language sql stable security definer set search_path to 'public' as $$
  select coalesce(nullif(nullif(o->'entregue'->>'valor','')::numeric,0),
    (select case when e.modo = 'taxa' then coalesce(nullif(o->>'taxa','')::numeric,0) else coalesce(e.valor,0) end from entregadores e where e.id = p_eid), 0) $$;

-- dia e mês no fuso da loja (Ajustes › Horário › fuso)
create or replace function public.loja_tz() returns text language sql stable security definer set search_path to 'public' as $$
  select coalesce(nullif((select data->'hor'->>'tz' from config where id='empresa'),''),'America/Sao_Paulo') $$;

create or replace function public.entregador_numeros(p_eid uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare tz text := loja_tz(); hoje date; mes date; r jsonb;
begin
  if not sou_admin() and sou_entregador() is distinct from p_eid then raise exception 'Sem permissão'; end if;
  hoje := (now() at time zone tz)::date; mes := date_trunc('month', now() at time zone tz)::date;
  with ent as (
    select (o.data->'entregue'->>'date')::timestamptz at time zone tz as quando, valor_entrega(o.data, p_eid) as valor,
      o.data->>'pay' as pay, coalesce(nullif(o.data->>'total','')::numeric,0) as total
    from orders o where o.data->>'st' = 'ent' and o.data->'entregue'->>'id' = p_eid::text)
  select jsonb_build_object(
    'hoje_n',  count(*) filter (where quando::date = hoje),
    'hoje_v',  coalesce(sum(valor) filter (where quando::date = hoje),0),
    'hoje_din',coalesce(sum(total) filter (where quando::date = hoje and pay = 'Dinheiro'),0),
    'mes_n',   count(*) filter (where quando::date >= mes),
    'mes_v',   coalesce(sum(valor) filter (where quando::date >= mes),0),
    'total_v', coalesce(sum(valor),0)) into r from ent;
  return r || jsonb_build_object(
    'pago_mes', coalesce((select sum(valor) from pagamentos_entregador where entregador_id = p_eid and (data at time zone tz)::date >= mes),0),
    'saldo', round((r->>'total_v')::numeric - coalesce((select sum(valor) from pagamentos_entregador where entregador_id = p_eid),0),2));
end $$;

-- tela do entregador: resumo + entregas e pagamentos do mês
create or replace function public.entregador_resumo() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare eid uuid := sou_entregador(); tz text := loja_tz(); mes date; e entregadores;
begin
  if eid is null then raise exception 'ENTREGADOR: este celular não está liberado'; end if;
  select * into e from entregadores where id = eid;
  mes := date_trunc('month', now() at time zone tz)::date;
  return entregador_numeros(eid) || jsonb_build_object('valor',e.valor,'modo',e.modo,
    'entregas',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'date',o.data->'entregue'->>'date','cn',split_part(coalesce(o.data->>'cn',''),' ',1),
        'bairro',o.data->>'bairro','valor',valor_entrega(o.data, eid)) order by o.data->'entregue'->>'date' desc)
      from orders o where o.data->>'st' = 'ent' and o.data->'entregue'->>'id' = eid::text and ((o.data->'entregue'->>'date')::timestamptz at time zone tz)::date >= mes),'[]'::jsonb),
    'pagamentos',coalesce((select jsonb_agg(jsonb_build_object('date',p.data,'valor',p.valor,'obs',p.obs) order by p.data desc)
      from pagamentos_entregador p where p.entregador_id = eid and (p.data at time zone tz)::date >= mes - 31),'[]'::jsonb));
end $$;

create or replace function public.configurar_entregador(p_id uuid, p_valor numeric, p_modo text) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if p_modo not in ('fixo','taxa') then raise exception 'Modo inválido'; end if;
  if coalesce(p_valor,0) < 0 or coalesce(p_valor,0) > 1000 then raise exception 'Valor inválido'; end if;
  update entregadores set valor = round(coalesce(p_valor,0),2), modo = p_modo where id = p_id;
end $$;

create or replace function public.pagar_entregador(p_id uuid, p_valor numeric, p_obs text default '', p_por text default '') returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if coalesce(p_valor,0) <= 0 then raise exception 'Informe o valor pago'; end if;
  insert into pagamentos_entregador(entregador_id,valor,obs,por) values (p_id, round(p_valor,2), left(coalesce(p_obs,''),120), left(coalesce(p_por,''),60));
  return entregador_numeros(p_id);
end $$;

do $$ declare f text; begin
  foreach f in array array['valor_entrega(jsonb,uuid)','entregador_resumo()','configurar_entregador(uuid,numeric,text)','pagar_entregador(uuid,numeric,text,text)','entregador_numeros(uuid)','loja_tz()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;


-- =====================================================================
-- FASE 9: MERCADO PAGO (pagamento pelo app)
-- O Access Token NÃO fica no Supabase: fica só no computador da loja.
-- O computador cria a cobrança, grava aqui o QR/link e confirma o pagamento.
-- =====================================================================
create or replace function public.pdv_pedido_mp(p_id text, p_mp jsonb, p_st text default null)
returns void language plpgsql security definer set search_path to 'public' as $$
declare old jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  select data into old from orders where id = p_id for update;
  if old is null then return; end if;
  old := old || jsonb_build_object('mp', coalesce(old->'mp','{}'::jsonb) || coalesce(p_mp,'{}'::jsonb));
  if p_st is not null and coalesce(old->>'st','') <> 'canc' then
    if p_st not in ('novo','pagar') then raise exception 'Situação inválida'; end if;
    old := old || jsonb_build_object('st', p_st, 'done', false);
  end if;
  update orders set data = old, updated_at = now() where id = p_id;
end $$;
revoke all on function public.pdv_pedido_mp(text, jsonb, text) from public, anon;
grant execute on function public.pdv_pedido_mp(text, jsonb, text) to authenticated;

-- o cliente desiste de pagar pelo app e escolhe pagar na entrega (só se ainda não pagou)
create or replace function public.pedido_pagar_na_entrega(p_id text, p_pay text, p_cash numeric default 0)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare old jsonb; tot numeric; c numeric := coalesce(p_cash,0);
begin
  if auth.uid() is null then raise exception 'Faça login'; end if;
  if p_pay not in ('Dinheiro','Pix','Cartão') then raise exception 'Forma de pagamento inválida'; end if;
  select data into old from orders where id = p_id and data->>'cid' = auth.uid()::text for update;
  if old is null then raise exception 'Pedido não encontrado'; end if;
  if old->>'st' <> 'pagar' or coalesce(old->'mp'->>'st','') = 'pago' then raise exception 'Este pedido não está aguardando pagamento'; end if;
  tot := (old->>'total')::numeric;
  if p_pay <> 'Dinheiro' then c := 0; end if;
  if c > 0 and c < tot then raise exception 'O valor para troco é menor que o total'; end if;
  old := old || jsonb_build_object('pay', p_pay, 'cash', c, 'troco', case when c > 0 then c - tot else 0 end, 'st', 'novo');
  update orders set data = old, updated_at = now() where id = p_id;
  return old;
end $$;
revoke all on function public.pedido_pagar_na_entrega(text, text, numeric) from public, anon;
grant execute on function public.pedido_pagar_na_entrega(text, text, numeric) to authenticated;


-- =====================================================================
-- FASE 10: INFINITEPAY (pagamento pelo app com link da InfinitePay)
-- O retorno do pagamento (volta do cliente e aviso da InfinitePay) só ANOTA
-- os códigos no pedido; quem confirma é o computador da loja, consultando a
-- InfinitePay (payment_check). Por isso estas funções podem ser públicas.
-- =====================================================================
create or replace function public.ip_anotar(p_id text, p_slug text, p_tnsu text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare old jsonb;
begin
  if p_id is null or coalesce(p_tnsu,'') = '' or coalesce(p_slug,'') = '' then return false; end if;
  select data into old from orders where id = p_id for update;
  if old is null or coalesce(old->>'gw', old->'mp'->>'gw', '') <> 'ip' then return false; end if;
  if coalesce(old->'mp'->>'st','') in ('pago','pago_tarde') then return true; end if;
  if old->>'st' not in ('pagar','canc','novo','conf') then return false; end if;
  update orders set data = old || jsonb_build_object('mp', coalesce(old->'mp','{}'::jsonb) || jsonb_build_object('ret',
      jsonb_build_object('slug', left(p_slug,120), 'tnsu', left(p_tnsu,120), 'em', now()))), updated_at = now()
   where id = p_id;
  return true;
end $$;
revoke all on function public.ip_anotar(text, text, text) from public, anon, authenticated;

-- o cliente volta da InfinitePay para o app (redirect_url)
create or replace function public.pedido_retorno_ip(p_id text, p_slug text, p_tnsu text)
returns boolean language sql security definer set search_path to 'public' as $$ select ip_anotar(p_id, p_slug, p_tnsu) $$;
revoke all on function public.pedido_retorno_ip(text, text, text) from public;
grant execute on function public.pedido_retorno_ip(text, text, text) to anon, authenticated;

-- aviso automático da InfinitePay (webhook): o corpo inteiro chega como um JSON só
create or replace function public.ip_webhook(jsonb)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
begin
  perform ip_anotar($1->>'order_nsu', coalesce($1->>'invoice_slug', $1->>'slug'), $1->>'transaction_nsu');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.ip_webhook(jsonb) from public;
grant execute on function public.ip_webhook(jsonb) to anon, authenticated;


-- =====================================================================
-- FASE 11: PARCEIROS (produtos de outros CNPJs vendidos pelo app)
-- O produto pode ter "Estoque: Parceiro X". No pedido, a parte do parceiro
-- vai para a tela dele (entra com código, sem senha), ele separa e marca
-- "pronto"; o entregador busca no caminho (ou o parceiro entrega).
-- A loja recebe do cliente e repassa ao parceiro (menos a comissão).
-- A nota dos produtos do parceiro é emitida pelo parceiro, no sistema dele.
-- =====================================================================
create table if not exists public.parceiros (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cnpj text default '',
  endereco text default '',
  loc jsonb,
  fone text default '',
  entrega text default 'busca',          -- busca = o entregador da loja busca · parceiro = o parceiro entrega
  comissao numeric(5,2) default 0,      -- % que fica com a loja
  codigo text,
  codigo_exp timestamptz,
  user_id uuid unique,
  ativo boolean default true,
  criado timestamptz default now(),
  ultimo timestamptz
);
alter table public.parceiros enable row level security;   -- sem políticas: só pelas funções
create table if not exists public.pagamentos_parceiro (
  id uuid primary key default gen_random_uuid(),
  parceiro_id uuid not null references public.parceiros(id),
  valor numeric(10,2) not null,
  obs text default '',
  por text default '',
  data timestamptz default now()
);
alter table public.pagamentos_parceiro enable row level security;

create or replace function public.sou_parceiro() returns uuid
language sql stable security definer set search_path to 'public' as $$
  select id from parceiros where user_id = auth.uid() and ativo $$;

-- valor vendido de um parceiro num pedido (itens com "parc" = ele)
create or replace function public.parc_valor(o jsonb, p_pid uuid) returns numeric
language sql immutable as $$
  select coalesce(sum(round((it->>'p')::numeric * (it->>'q')::numeric, 2)), 0)
  from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) it where it->>'parc' = p_pid::text $$;

-- pedido concluído conta para o repasse: entregue, ou faturado no caixa, e não cancelado
create or replace function public.parc_conta(o jsonb) returns boolean
language sql immutable as $$ select coalesce(o->>'st','') <> 'canc' and (o->>'st' = 'ent' or o ? 'fat') $$;

create or replace function public.parceiro_numeros(p_pid uuid) returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare com numeric; tz text := coalesce((select data->'hor'->>'tz' from config where id = 'empresa'), 'America/Sao_Paulo');
  hoje date := (now() at time zone tz)::date; vh numeric := 0; vm numeric := 0; vt numeric := 0; nh int := 0; nm int := 0; pg numeric := 0; r record;
begin
  select comissao into com from parceiros where id = p_pid;
  for r in select o.data as d, ((o.data->>'date')::timestamptz at time zone tz)::date as dia from orders o
           where o.data->'parts' ? p_pid::text and parc_conta(o.data) loop
    vt := vt + parc_valor(r.d, p_pid);
    if r.dia = hoje then vh := vh + parc_valor(r.d, p_pid); nh := nh + 1; end if;
    if date_trunc('month', r.dia) = date_trunc('month', hoje) then vm := vm + parc_valor(r.d, p_pid); nm := nm + 1; end if;
  end loop;
  select coalesce(sum(valor),0) into pg from pagamentos_parceiro where parceiro_id = p_pid;
  return jsonb_build_object('comissao',coalesce(com,0),'hoje',vh,'nHoje',nh,'mes',vm,'nMes',nm,'vendido',vt,
    'repasse',round(vt * (1 - coalesce(com,0)/100), 2),'pago',pg,'saldo',round(vt * (1 - coalesce(com,0)/100), 2) - pg);
end $$;

/* ----- a loja (Gestão) ----- */
create or replace function public.listar_parceiros() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'nome',p.nome,'cnpj',p.cnpj,'endereco',p.endereco,'loc',p.loc,'fone',p.fone,'entrega',p.entrega,
    'comissao',p.comissao,'pareado',p.user_id is not null,'ultimo',p.ultimo,'codigo',case when p.codigo_exp > now() then p.codigo end,'exp',p.codigo_exp) || parceiro_numeros(p.id) order by p.nome)
    from parceiros p where p.ativo),'[]'::jsonb);
end $$;

create or replace function public.salvar_parceiro(p jsonb) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r parceiros; nid uuid := nullif(p->>'id','')::uuid;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if coalesce(trim(p->>'nome'),'') = '' then raise exception 'Informe o nome do parceiro'; end if;
  if coalesce(p->>'entrega','busca') not in ('busca','parceiro') then raise exception 'Forma de entrega inválida'; end if;
  if coalesce(nullif(p->>'comissao','')::numeric,0) < 0 or coalesce(nullif(p->>'comissao','')::numeric,0) > 90 then raise exception 'Comissão deve ficar entre 0 e 90%%'; end if;
  if nid is null then
    insert into parceiros(nome,cnpj,endereco,loc,fone,entrega,comissao,codigo,codigo_exp)
    values (left(trim(p->>'nome'),80), regexp_replace(coalesce(p->>'cnpj',''),'\D','','g'), left(coalesce(p->>'endereco',''),200), p->'loc', regexp_replace(coalesce(p->>'fone',''),'\D','','g'),
            coalesce(p->>'entrega','busca'), coalesce(nullif(p->>'comissao','')::numeric,0), ent_codigo(), now() + interval '24 hours') returning * into r;
  else
    update parceiros set nome = left(trim(p->>'nome'),80), cnpj = regexp_replace(coalesce(p->>'cnpj',''),'\D','','g'), endereco = left(coalesce(p->>'endereco',''),200),
      loc = coalesce(p->'loc', loc), fone = regexp_replace(coalesce(p->>'fone',''),'\D','','g'), entrega = coalesce(p->>'entrega','busca'), comissao = coalesce(nullif(p->>'comissao','')::numeric,0)
    where id = nid and ativo returning * into r;
    if r.id is null then raise exception 'Parceiro não encontrado'; end if;
  end if;
  return jsonb_build_object('id',r.id,'nome',r.nome,'codigo',case when r.codigo_exp > now() then r.codigo end,'exp',r.codigo_exp);
end $$;

create or replace function public.novo_codigo_parceiro(p_id uuid) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r parceiros;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  update parceiros set codigo = ent_codigo(), codigo_exp = now() + interval '24 hours', user_id = null where id = p_id and ativo returning * into r;
  if r.id is null then raise exception 'Parceiro não encontrado'; end if;
  return jsonb_build_object('id',r.id,'nome',r.nome,'codigo',r.codigo,'exp',r.codigo_exp);
end $$;

create or replace function public.remover_parceiro(p_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  update parceiros set ativo = false, user_id = null, codigo = null where id = p_id;
end $$;

create or replace function public.pagar_parceiro(p_id uuid, p_valor numeric, p_obs text default '', p_por text default '') returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  if coalesce(p_valor,0) = 0 then raise exception 'Informe o valor'; end if;
  insert into pagamentos_parceiro(parceiro_id,valor,obs,por) values (p_id, round(p_valor,2), left(coalesce(p_obs,''),200), left(coalesce(p_por,''),60));
  return parceiro_numeros(p_id);
end $$;

-- extrato de um parceiro (para a loja e para o próprio parceiro)
create or replace function public.parc_extrato(p_pid uuid, p_dias int default 31) returns jsonb
language sql stable security definer set search_path to 'public' as $$
  select jsonb_build_object(
    'vendas', coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'date',o.data->>'date','st',o.data->>'st','valor',parc_valor(o.data,p_pid),'nota',o.data->'parts'->p_pid::text->>'nota',
        'itens',(select jsonb_agg(jsonb_build_object('n',it->>'n','q',it->'q','p',it->'p','u',it->>'u')) from jsonb_array_elements(o.data->'items') it where it->>'parc' = p_pid::text)) order by o.data->>'date' desc)
      from orders o where o.data->'parts' ? p_pid::text and parc_conta(o.data) and (o.data->>'date')::timestamptz > now() - make_interval(days => p_dias)),'[]'::jsonb),
    'pagamentos', coalesce((select jsonb_agg(jsonb_build_object('valor',valor,'obs',obs,'por',por,'data',data) order by data desc) from pagamentos_parceiro where parceiro_id = p_pid and data > now() - make_interval(days => p_dias)),'[]'::jsonb)) $$;

create or replace function public.extrato_parceiro(p_id uuid, p_dias int default 31) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  return parc_extrato(p_id, p_dias) || parceiro_numeros(p_id);
end $$;

-- a loja marca a parte do parceiro pelo caixa (quando o parceiro não usa a tela dele) e o entregador marca a coleta
create or replace function public.pdv_parte(p_id text, p_parc text, p_patch jsonb) returns void
language plpgsql security definer set search_path to 'public' as $$
declare old jsonb;
begin
  if not sou_admin() then raise exception 'Somente a loja'; end if;
  select data into old from orders where id = p_id for update;
  if old is null or not (old->'parts' ? p_parc) then return; end if;
  update orders set data = jsonb_set(old, array['parts', p_parc], (old->'parts'->p_parc) || coalesce(p_patch,'{}'::jsonb)), updated_at = now() where id = p_id;
end $$;

/* ----- o parceiro (tela dele no celular) ----- */
create or replace function public.parceiro_parear(p_codigo text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r parceiros; c text := upper(regexp_replace(coalesce(p_codigo,''),'[^A-Za-z0-9]','','g'));
begin
  if auth.uid() is null then raise exception 'Abra pelo link do parceiro'; end if;
  if length(c) <> 8 then raise exception 'Código inválido'; end if;
  select * into r from parceiros where codigo = c and codigo_exp > now() and ativo for update;
  if r.id is null then raise exception 'Código inválido ou vencido. Peça um novo para a loja.'; end if;
  update parceiros set user_id = null where user_id = auth.uid() and id <> r.id;
  update parceiros set user_id = auth.uid(), codigo = null, codigo_exp = null, ultimo = now() where id = r.id;
  return jsonb_build_object('id',r.id,'nome',r.nome);
end $$;

create or replace function public.parceiro_eu() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare r parceiros; cfg jsonb;
begin
  select * into r from parceiros where user_id = auth.uid() and ativo;
  if r.id is null then return null; end if;
  update parceiros set ultimo = now() where id = r.id;
  select data into cfg from config where id = 'empresa';
  return jsonb_build_object('id',r.id,'nome',r.nome,'entrega',r.entrega,'comissao',r.comissao,'loja',cfg->>'n','tel',cfg->>'tel','logo',cfg->>'logo');
end $$;

-- pedidos com produtos dele: aceitos pela loja (últimos 2 dias) + concluídos/cancelados recentes.
-- Dados do cliente (nome, telefone, endereço) só quando é o parceiro que entrega.
create or replace function public.parceiro_pedidos() returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare pid uuid := sou_parceiro(); ent text;
begin
  if pid is null then raise exception 'PARCEIRO: este celular não está liberado'; end if;
  select entrega into ent from parceiros where id = pid;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id',o.id,'date',o.data->>'date','st',o.data->>'st','ent',coalesce(o.data->>'ent','entrega'),'obs',o.data->>'obs',
      'parte',o.data->'parts'->pid::text,'rota',o.data->'rota'->>'nome','valor',parc_valor(o.data,pid),
      'items',(select jsonb_agg(jsonb_build_object('n',it->>'n','q',it->'q','u',it->>'u','p',it->'p')) from jsonb_array_elements(o.data->'items') it where it->>'parc' = pid::text),
      'cliente',case when ent = 'parceiro' or coalesce(o.data->>'ent','entrega') = 'retirada' then jsonb_build_object('cn',o.data->>'cn','ph',o.data->>'ph','addr',o.data->>'addr','bairro',o.data->>'bairro','ref',o.data->>'ref','loc',o.data->'loc') end
    ) order by o.data->>'date' desc)
    from orders o
    where o.data->'parts' ? pid::text
      and ((o.data->>'st' = 'conf' and o.updated_at > now() - interval '2 days')
        or (o.data->>'st' in ('ent','canc') and o.updated_at > now() - interval '20 hours'))),'[]'::jsonb);
end $$;

create or replace function public.parceiro_marcar(p_id text, p_st text, p_nota text default null, p_obs text default null) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare pid uuid := sou_parceiro(); old jsonb; parte jsonb; agora text := to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"');
begin
  if pid is null then raise exception 'PARCEIRO: este celular não está liberado'; end if;
  if p_st not in ('aceito','pronto','saiu','entregue','falta','nota') then raise exception 'Situação inválida'; end if;
  select data into old from orders where id = p_id for update;
  if old is null or not (old->'parts' ? pid::text) then raise exception 'Pedido não encontrado'; end if;
  if old->>'st' = 'canc' then raise exception 'Este pedido foi cancelado pela loja'; end if;
  if p_st <> 'nota' and old->>'st' <> 'conf' and not (p_st = 'entregue' and old->>'st' = 'ent') then raise exception 'Este pedido não está mais em andamento'; end if;
  parte := old->'parts'->pid::text;
  if p_st <> 'nota' then parte := parte || jsonb_build_object('st',p_st, p_st, agora); end if;
  if p_nota is not null then parte := parte || jsonb_build_object('nota', left(trim(p_nota),60)); end if;
  if p_obs is not null then parte := parte || jsonb_build_object('obs', left(trim(p_obs),200)); end if;
  update orders set data = jsonb_set(old, array['parts', pid::text], parte), updated_at = now() where id = p_id;
  return parte;
end $$;

create or replace function public.parceiro_resumo(p_dias int default 31) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare pid uuid := sou_parceiro();
begin
  if pid is null then raise exception 'PARCEIRO: este celular não está liberado'; end if;
  return parc_extrato(pid, least(greatest(coalesce(p_dias,31),1),93)) || parceiro_numeros(pid);
end $$;

-- o entregador marca que buscou a parte do parceiro
create or replace function public.entregador_coletou(p_id text, p_parc text) returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare eid uuid := sou_entregador(); nm text; old jsonb;
begin
  if eid is null then raise exception 'ENTREGADOR: este celular não está liberado'; end if;
  select nome into nm from entregadores where id = eid;
  select data into old from orders where id = p_id for update;
  if old is null or not (old->'parts' ? p_parc) then raise exception 'Pedido não encontrado'; end if;
  if old->>'st' <> 'conf' then raise exception 'Este pedido não está mais esperando entrega'; end if;
  update orders set data = jsonb_set(old, array['parts', p_parc], (old->'parts'->p_parc) || jsonb_build_object('col', jsonb_build_object('por',nm,'date',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')))), updated_at = now() where id = p_id;
  return jsonb_build_object('ok',true);
end $$;

do $$ declare f text; begin
  foreach f in array array['listar_parceiros()','salvar_parceiro(jsonb)','novo_codigo_parceiro(uuid)','remover_parceiro(uuid)','pagar_parceiro(uuid,numeric,text,text)','extrato_parceiro(uuid,integer)',
    'pdv_parte(text,text,jsonb)','parceiro_parear(text)','parceiro_eu()','parceiro_pedidos()','parceiro_marcar(text,text,text,text)','parceiro_resumo(integer)','entregador_coletou(text,text)','sou_parceiro()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
  foreach f in array array['parceiro_numeros(uuid)','parc_extrato(uuid,integer)'] loop
    execute 'revoke all on function public.' || f || ' from public, anon, authenticated';
  end loop;
end $$;
