/* Mercado Online · estrutura de DEPARTAMENTO › CATEGORIA (padrão de gerenciamento por categorias do varejo)
   e classificação automática do produto pelo nome. Usado pelo servidor, pela Gestão e pelo PDV. */
(function (g) {
  /* [departamento, [[categoria, [palavras do nome que indicam a categoria]], ...]] */
  const TAX0 = [
    ['MERCEARIA BÁSICA', [
      ['ARROZ', ['ARROZ']], ['FEIJÃO', ['FEIJAO']], ['AÇÚCAR E ADOÇANTES', ['ACUCAR', 'ADOCANTE']],
      ['SAL E TEMPEROS', ['SAL ', 'SAL REFINADO', 'TEMPERO', 'SAZON', 'CALDO ', 'COLORAU', 'COMINHO', 'PIMENTA DO REINO', 'OREGANO', 'CANELA', 'CRAVO', 'LOURO']],
      ['ÓLEOS E AZEITES', ['OLEO', 'AZEITE']],
      ['FARINHAS E GRÃOS', ['FARINHA', 'FUBA', 'AVEIA', 'PIPOCA', 'TAPIOCA', 'POLVILHO', 'FAROFA', 'GOMA', 'AMIDO', 'MAIZENA', 'CANJICA', 'LENTILHA', 'GRAO DE BICO']],
      ['MASSAS', ['MACARRAO', 'ESPAGUETE', 'PARAFUSO', 'PENNE', 'LASANHA', 'MIOJO', 'INSTANTANEO', 'NISSIN', 'TALHARIM']],
      ['MOLHOS E CONDIMENTOS', ['MOLHO', 'KETCHUP', 'MAIONESE', 'MOSTARDA', 'VINAGRE', 'EXTRATO', 'CATCHUP']],
      ['ENLATADOS E CONSERVAS', ['SARDINHA', 'ATUM', 'MILHO VERDE', 'ERVILHA', 'SELETA', 'PALMITO', 'AZEITONA', 'CONSERVA', 'PESSEGO CALDA']]]],
    ['MATINAIS E DOCES', [
      ['CAFÉ', ['CAFE']], ['ACHOCOLATADOS', ['ACHOCOLATADO', 'NESCAU', 'TODDY']], ['LEITE EM PÓ', ['LEITE PO', 'LEITE EM PO', 'NINHO']],
      ['BISCOITOS', ['BISCOITO', 'BOLACHA', 'WAFER', 'ROSQUINHA', 'CREAM CRACKER', 'RECHEADO', 'TORRADA']],
      ['CEREAIS', ['CEREAL', 'GRANOLA', 'SUCRILHOS']],
      ['DOCES E SOBREMESAS', ['GELATINA', 'PUDIM', 'LEITE CONDENSADO', 'CREME DE LEITE', 'GOIABADA', 'MISTURA BOLO', 'MISTURA P/ BOLO', 'FERMENTO', 'DOCE DE LEITE', 'MEL ', 'GELEIA']],
      ['CHOCOLATES E BALAS', ['CHOCOLATE', 'BOMBOM', 'BALA ', 'BALAS', 'PIRULITO', 'CHICLETE', 'BATON', 'PACOCA']]]],
    ['BEBIDAS', [
      ['ÁGUA', ['AGUA MINERAL', 'AGUA S/GAS', 'AGUA C/GAS', 'AGUA COM GAS', 'AGUA SEM GAS', 'AGUA ']],
      ['REFRIGERANTES', ['REFRIG', 'COCA COLA', 'COCA-COLA', 'GUARANA', 'FANTA', 'PEPSI', 'SPRITE', 'SODA', 'SCHWEPPES', 'KUAT', 'SUKITA']],
      ['SUCOS', ['SUCO', 'TANG', 'REFRESCO', 'NECTAR', 'DEL VALLE', 'FRESH']],
      ['ENERGÉTICOS E ISOTÔNICOS', ['ENERGETICO', 'RED BULL', 'MONSTER', 'ISOTONICO', 'GATORADE', 'POWERADE']],
      ['CERVEJAS', ['CERVEJA', 'BRAHMA', 'SKOL', 'HEINEKEN', 'ANTARCTICA', 'ITAIPAVA', 'AMSTEL', 'BUDWEISER', 'STELLA', 'SPATEN', 'BOHEMIA', 'CORONA']],
      ['DESTILADOS', ['CACHACA', 'PINGA', 'VODKA', 'WHISKY', 'CONHAQUE', 'GIN ', 'RUM ', 'TEQUILA', 'YPIOCA', 'SMIRNOFF']],
      ['VINHOS', ['VINHO', 'ESPUMANTE', 'SANGRIA']]]],
    ['FRIOS E LATICÍNIOS', [
      ['LEITE', ['LEITE']], ['IOGURTES', ['IOGURTE', 'BEBIDA LACTEA', 'DANONE', 'ACTIVIA', 'PETIT SUISSE', 'DANONINHO']],
      ['QUEIJOS', ['QUEIJO', 'MUSSARELA', 'MUCARELA', 'REQUEIJAO', 'PARMESAO', 'RICOTA']],
      ['MANTEIGA E MARGARINA', ['MANTEIGA', 'MARGARINA', 'QUALY', 'DORIANA']],
      ['FRIOS E EMBUTIDOS', ['PRESUNTO', 'MORTADELA', 'SALAME', 'APRESUNTADO', 'PEITO PERU', 'PEITO DE PERU', 'SALSICHA', 'BLANQUET']]]],
    ['AÇOUGUE', [
      ['BOVINOS', ['BOVIN', 'CARNE', 'PICANHA', 'ALCATRA', 'PATINHO', 'COSTELA', 'ACEM', 'MUSCULO', 'CONTRA FILE', 'CONTRAFILE', 'FIGADO', 'COXAO', 'CUPIM', 'MAMINHA', 'FRALDINHA', 'MOIDA']],
      ['SUÍNOS', ['SUIN', 'PERNIL', 'LOMBO', 'BACON', 'TOUCINHO', 'PANCETA', 'BISTECA']],
      ['AVES', ['FRANGO', 'COXA', 'SOBRECOXA', 'ASA DE', 'ASINHA', 'CHESTER', 'PEITO FRANGO', 'MOELA', 'CORACAO']],
      ['PEIXES E FRUTOS DO MAR', ['PEIXE', 'TILAPIA', 'PESCADA', 'MERLUZA', 'CAMARAO', 'TAMBAQUI', 'PIRARUCU']],
      ['LINGUIÇAS', ['LINGUICA', 'CALABRESA', 'TOSCANA']]]],
    ['HORTIFRUTI', [
      ['FRUTAS', ['BANANA', 'MACA ', 'LARANJA', 'MAMAO', 'MELANCIA', 'UVA', 'LIMAO', 'ABACAXI', 'MANGA', 'PERA', 'MELAO', 'GOIABA', 'MARACUJA', 'ABACATE', 'TANGERINA', 'MORANGO', 'KIWI', 'COCO']],
      ['LEGUMES', ['BATATA', 'CEBOLA', 'TOMATE', 'CENOURA', 'ALHO', 'ABOBORA', 'PIMENTAO', 'CHUCHU', 'MANDIOCA', 'MACAXEIRA', 'PEPINO', 'BETERRABA', 'INHAME', 'QUIABO', 'MAXIXE', 'JILO', 'BERINJELA', 'ABOBRINHA', 'VAGEM']],
      ['VERDURAS', ['ALFACE', 'COUVE', 'CHEIRO VERDE', 'REPOLHO', 'RUCULA', 'CEBOLINHA', 'COENTRO', 'BROCOLIS', 'ESPINAFRE', 'SALSA', 'AGRIAO', 'CHICORIA']],
      ['OVOS', ['OVO']]]],
    ['PADARIA', [
      ['PÃES', ['PAO ', 'PAES', 'BISNAGUINHA', 'PAO FRANCES', 'PAO DE FORMA']], ['BOLOS', ['BOLO']], ['SALGADOS', ['SALGADO', 'COXINHA', 'PASTEL', 'ESFIRRA', 'EMPADA']]]],
    ['CONGELADOS', [
      ['PRATOS PRONTOS', ['LASANHA CONG', 'PIZZA', 'HAMBURGUER', 'NUGGETS', 'EMPANADO', 'STEAK']],
      ['SORVETES', ['SORVETE', 'PICOLE', 'ACAI', 'POLPA']],
      ['PÃO DE QUEIJO', ['PAO DE QUEIJO']],
      ['VEGETAIS CONGELADOS', ['CONGELAD', 'BATATA PALITO']]]],
    ['LIMPEZA', [
      ['ROUPA', ['SABAO PO', 'SABAO EM PO', 'SABAO LIQ', 'LAVA ROUPA', 'AMACIANTE', 'ALVEJANTE', 'OMO', 'TIRA MANCHA', 'SABAO BARRA', 'SABAO EM BARRA', 'YPE SABAO']],
      ['LOUÇA', ['DETERGENTE', 'LAVA LOUCA', 'ESPONJA', 'PALHA DE ACO', 'BOMBRIL', 'BUCHA']],
      ['MULTIUSO E DESINFETANTES', ['DESINFETANTE', 'MULTIUSO', 'AGUA SANITARIA', 'CANDIDA', 'LIMPADOR', 'CLORO', 'VEJA', 'PINHO', 'LIMPA ', 'INSETICIDA', 'BAYGON', 'RAID', 'LUSTRA MOVEIS', 'CERA']],
      ['PAPEL E DESCARTÁVEIS', ['PAPEL TOALHA', 'GUARDANAPO', 'COPO DESC', 'PRATO DESC', 'SACO LIXO', 'SACO DE LIXO', 'SACO P/ LIXO', 'PAPEL ALUMINIO', 'FILME PVC', 'PALITO', 'DESCARTAVEL']]]],
    ['HIGIENE E PERFUMARIA', [
      ['HIGIENE ORAL', ['CREME DENTAL', 'ESCOVA DENT', 'FIO DENTAL', 'ENXAGUANTE', 'COLGATE', 'SORRISO', 'CLOSE UP', 'ORAL B']],
      ['CABELO', ['SHAMPOO', 'XAMPU', 'CONDICIONADOR', 'CREME P/ PENTEAR', 'CREME PENTEAR', 'CREME CABELO', 'TINTURA', 'GEL CABELO', 'FINALIZADOR']],
      ['SABONETES', ['SABONETE']],
      ['DESODORANTES', ['DESODORANTE', 'ANTITRANSPIRANTE', 'REXONA', 'NIVEA DEO']],
      ['FRALDAS E ABSORVENTES', ['FRALDA', 'ABSORVENTE', 'LENCO UMEDECIDO', 'PAMPERS', 'HUGGIES']],
      ['PAPEL HIGIÊNICO', ['PAPEL HIG', 'PAPEL HIGIENICO']],
      ['CUIDADOS PESSOAIS', ['APARELHO BARBEAR', 'LAMINA', 'HASTE FLEXIVEL', 'COTONETE', 'ALGODAO', 'CREME HIDRATANTE', 'HIDRATANTE', 'PROTETOR SOLAR', 'REPELENTE', 'ESMALTE', 'ACETONA']]]],
    ['BAZAR E UTILIDADES', [
      ['UTENSÍLIOS', ['PANELA', 'COPO ', 'PRATO ', 'TALHER', 'VASSOURA', 'RODO', 'BALDE', 'PREGADOR', 'PANO DE CHAO', 'PANO DE PRATO', 'POTE ', 'GARRAFA TERMICA']],
      ['PILHAS E LÂMPADAS', ['PILHA', 'LAMPADA', 'BATERIA']],
      ['CARVÃO E FÓSFOROS', ['CARVAO', 'FOSFORO', 'ACENDEDOR', 'ISQUEIRO', 'ALCOOL ']]]],
    ['PET', [
      ['RAÇÃO', ['RACAO', 'PEDIGREE', 'WHISKAS']], ['PETISCOS', ['PETISCO', 'BIFINHO', 'OSSINHO']], ['AREIA E HIGIENE PET', ['AREIA GATO', 'AREIA SANITARIA', 'TAPETE HIGIENICO']]]]
  ];
  const sem = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  /* estrutura simples (sem as palavras) para gravar nos ajustes da loja: [{d, c:[...]}] */
  const padrao = () => TAX0.map(([d, cs]) => ({ d, c: cs.map(x => x[0]) }));
  /* estrutura em uso: a da loja (se houver) ou a padrão */
  const estrutura = emp => (emp && Array.isArray(emp.tax) && emp.tax.length ? emp.tax : padrao());
  /* departamento de uma categoria */
  function depDe(cat, tax) { const c = sem(cat).trim(); if (!c) return ''; for (const t of tax || padrao()) if ((t.c || []).some(x => sem(x).trim() == c)) return t.d; return '' }
  /* classifica pelo nome: a palavra mais longa encontrada vence (LEITE CONDENSADO > LEITE) */
  function classificar(nome, tax) {
    const n = ' ' + sem(nome).replace(/[^A-Z0-9/ ]+/g, ' ').replace(/\s+/g, ' ') + ' ';
    let best = null;
    for (const [d, cs] of TAX0) for (const [c, ws] of cs) for (const w of ws) {
      const k = sem(w); if (n.includes(' ' + k) && (!best || k.length > best.k.length)) best = { d, c, k };   // só no começo de palavra (UVA ≠ LUVA)
    }
    // categorias criadas pela loja: o próprio nome da categoria vale como palavra
    for (const t of tax || []) for (const c of t.c || []) { const k = ' ' + sem(c) + ' '; if (k.trim().length >= 3 && n.includes(k) && (!best || k.length > best.k.length)) best = { d: t.d, c, k } }
    if (!best) return null;
    // usa a grafia da estrutura da loja, se existir
    const d2 = (tax || []).find(t => sem(t.d) == sem(best.d)), c2 = d2 && (d2.c || []).find(x => sem(x) == sem(best.c));
    return { dep: d2 ? d2.d : best.d, c: c2 || best.c };
  }
  const X = { TAX0, padrao, estrutura, depDe, classificar, sem };
  if (typeof module != 'undefined' && module.exports) module.exports = X; else g.DEPCAT = X;
})(this);
