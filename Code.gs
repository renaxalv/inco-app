/**
 * Painel Inco — backend (Google Apps Script)
 * Banco de dados: Google Sheets (abas Usuarios, Sessoes, Investimentos, Parametros)
 * Multiusuário: cada investimento carrega o userId do dono; toda API filtra por ele.
 */

const SHEET_ID = '1KAQ9tfspiZbsCLe3G1bfIwFXMkR4ysUmSoUclje5l0Q';
const SESSAO_DIAS = 30;
const ITER_HASH = 1000;

const SCHEMA = {
  Usuarios:      ['id', 'nome', 'email', 'senhaHash', 'salt', 'criadoEm', 'ultimoLogin', 'ativo'],
  Sessoes:       ['tokenHash', 'userId', 'criadoEm', 'expiraEm'],
  Investimentos: ['id', 'userId', 'nome', 'pagamento', 'risco', 'prazoMeses', 'indexador', 'taxa', 'ir',
                  'proximaParcela', 'valor', 'dataInvestimento', 'vencimento', 'criadoEm', 'atualizadoEm', 'ativo'],
  Parametros:    ['chave', 'valor', 'atualizadoEm']
};
const COLUNAS_TEXTO = ['id', 'userId', 'proximaParcela', 'dataInvestimento', 'vencimento', 'criadoEm', 'atualizadoEm',
                       'expiraEm', 'ultimoLogin', 'tokenHash', 'senhaHash', 'salt'];

/* ===================== Web app ===================== */

function doGet() {
  ensureSchema_();
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Painel Inco')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/**
 * API JSON para o frontend PWA (hospedado fora do Apps Script).
 * O frontend envia POST com corpo text/plain contendo {"fn":"apiLogin","args":[...]} (evita preflight de CORS).
 */
const FUNCOES_API = {
  apiCadastrar: apiCadastrar, apiLogin: apiLogin, apiSessao: apiSessao, apiLogout: apiLogout,
  apiListar: apiListar, apiSalvar: apiSalvar, apiExcluir: apiExcluir, apiTaxas: apiTaxas
};
function doPost(e) {
  let saida;
  try {
    const req = JSON.parse(e.postData.contents);
    const f = FUNCOES_API[req.fn];
    if (!f) throw new Error('Função inválida.');
    ensureSchema_();
    saida = f.apply(null, Array.isArray(req.args) ? req.args : []);
  } catch (err) {
    saida = { ok: false, erro: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(saida)).setMimeType(ContentService.MimeType.JSON);
}

/** Roda uma vez no editor (ou automaticamente no primeiro acesso) para criar as abas. */
function setup() { ensureSchema_(true); return 'Abas verificadas: ' + Object.keys(SCHEMA).join(', '); }

/* ===================== API pública (google.script.run) ===================== */

function apiCadastrar(nome, email, senha) {
  return seguro_(function () {
    nome = String(nome || '').trim(); email = normEmail_(email); senha = String(senha || '');
    if (nome.length < 2) throw new Error('Informe seu nome.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('E-mail inválido.');
    if (senha.length < 6) throw new Error('A senha precisa ter pelo menos 6 caracteres.');
    return comLock_(function () {
      if (linhas_('Usuarios').some(function (u) { return u.email === email; })) throw new Error('Este e-mail já está cadastrado.');
      const salt = Utilities.getUuid();
      const user = { id: 'u_' + Utilities.getUuid().slice(0, 8), nome: nome, email: email, senhaHash: hash_(senha, salt),
                     salt: salt, criadoEm: agora_(), ultimoLogin: agora_(), ativo: true };
      inserir_('Usuarios', user);
      return { ok: true, token: criarSessao_(user.id), user: { id: user.id, nome: nome, email: email } };
    });
  });
}

function apiLogin(email, senha) {
  return seguro_(function () {
    email = normEmail_(email); senha = String(senha || '');
    const cache = CacheService.getScriptCache(), kf = 'falhas_' + email;
    if (Number(cache.get(kf) || 0) >= 5) throw new Error('Muitas tentativas. Aguarde 10 minutos.');
    const u = linhas_('Usuarios').filter(function (x) { return x.email === email && x.ativo !== false && x.ativo !== 'FALSE'; })[0];
    if (!u || hash_(senha, u.salt) !== u.senhaHash) {
      cache.put(kf, String(Number(cache.get(kf) || 0) + 1), 600);
      throw new Error('E-mail ou senha incorretos.');
    }
    cache.remove(kf);
    return comLock_(function () {
      atualizar_('Usuarios', u._row, { ultimoLogin: agora_() });
      limparSessoes_();
      return { ok: true, token: criarSessao_(u.id), user: { id: u.id, nome: u.nome, email: u.email } };
    });
  });
}

function apiSessao(token) {
  return seguro_(function () { const u = usuario_(token); return { ok: true, user: { id: u.id, nome: u.nome, email: u.email } }; });
}

function apiLogout(token) {
  return seguro_(function () {
    return comLock_(function () {
      const h = hash_(String(token || ''), 'tk');
      linhas_('Sessoes').filter(function (s) { return s.tokenHash === h; }).reverse()
        .forEach(function (s) { sh_('Sessoes').deleteRow(s._row); });
      return { ok: true };
    });
  });
}

function apiListar(token) {
  return seguro_(function () {
    const u = usuario_(token);
    const lista = linhas_('Investimentos').filter(function (i) { return i.userId === u.id && i.ativo !== false && i.ativo !== 'FALSE'; })
      .map(paraCliente_);
    return { ok: true, investimentos: lista };
  });
}

function apiSalvar(token, d) {
  return seguro_(function () {
    const u = usuario_(token), inv = validar_(d);
    return comLock_(function () {
      if (d.id) {
        const atual = linhas_('Investimentos').filter(function (i) { return i.id === d.id && i.userId === u.id; })[0];
        if (!atual) throw new Error('Investimento não encontrado.');
        inv.atualizadoEm = agora_();
        atualizar_('Investimentos', atual._row, inv);
        inv.id = d.id;
      } else {
        inv.id = 'i_' + Utilities.getUuid().slice(0, 8); inv.userId = u.id; inv.criadoEm = agora_(); inv.atualizadoEm = agora_(); inv.ativo = true;
        inserir_('Investimentos', inv);
      }
      return { ok: true, id: inv.id };
    });
  });
}

function apiExcluir(token, id) {
  return seguro_(function () {
    const u = usuario_(token);
    return comLock_(function () {
      const atual = linhas_('Investimentos').filter(function (i) { return i.id === id && i.userId === u.id; })[0];
      if (!atual) throw new Error('Investimento não encontrado.');
      atualizar_('Investimentos', atual._row, { ativo: false, atualizadoEm: agora_() }); // exclusão lógica
      return { ok: true };
    });
  });
}

/** CDI e IPCA atuais (Banco Central), com cache de 6h e fallback na aba Parametros. */
function apiTaxas(token, forcar) {
  return seguro_(function () { usuario_(token); return { ok: true, taxas: taxas_(!!forcar) }; });
}

/* ===================== Taxas (API do Banco Central) ===================== */

function taxas_(forcar) {
  const cache = CacheService.getScriptCache();
  if (!forcar) { const c = cache.get('taxas'); if (c) return JSON.parse(c); }
  let t = null;
  try {
    // CDI anualizado (base 252) — SGS 4389
    const cdiRows = JSON.parse(UrlFetchApp.fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.4389/dados/ultimos/1?formato=json', { muteHttpExceptions: true }).getContentText());
    const cdi = parseFloat(cdiRows[0].valor), cdiData = cdiRows[0].data;
    // IPCA esperado nos próximos 12 meses (Boletim Focus, mediana suavizada); fallback: IPCA acumulado 12m (SGS 13522)
    let ipca = null, ipcaFonte = '';
    try {
      const url = 'https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativasMercadoInflacao12Meses'
        + "?$top=1&$filter=Indicador%20eq%20'IPCA'%20and%20Suavizada%20eq%20'S'%20and%20baseCalculo%20eq%200&$orderby=Data%20desc&$format=json";
      const f = JSON.parse(UrlFetchApp.fetch(url, { muteHttpExceptions: true }).getContentText()).value[0];
      ipca = Number(f.Mediana); ipcaFonte = 'Focus 12m (' + f.Data + ')';
    } catch (e) {}
    if (!ipca) {
      const r = JSON.parse(UrlFetchApp.fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.13522/dados/ultimos/1?formato=json', { muteHttpExceptions: true }).getContentText());
      ipca = parseFloat(r[0].valor); ipcaFonte = 'IPCA acum. 12m (' + r[0].data + ')';
    }
    if (!isFinite(cdi) || !isFinite(ipca)) throw new Error('resposta inválida');
    t = { cdi: cdi, ipca: ipca, cdiData: cdiData, ipcaFonte: ipcaFonte, atualizadoEm: agora_(), origem: 'bcb' };
    salvarParametro_('taxas', JSON.stringify(t));
  } catch (e) {
    const guardado = lerParametro_('taxas');
    t = guardado ? JSON.parse(guardado) : { cdi: 14, ipca: 4.5, cdiData: '', ipcaFonte: 'padrão', atualizadoEm: agora_() };
    t.origem = guardado ? 'ultimo-valor-salvo' : 'padrao';
  }
  cache.put('taxas', JSON.stringify(t), 6 * 3600);
  return t;
}

function lerParametro_(chave) {
  const p = linhas_('Parametros').filter(function (x) { return x.chave === chave; })[0];
  return p ? p.valor : null;
}
function salvarParametro_(chave, valor) {
  comLock_(function () {
    const p = linhas_('Parametros').filter(function (x) { return x.chave === chave; })[0];
    if (p) atualizar_('Parametros', p._row, { valor: valor, atualizadoEm: agora_() });
    else inserir_('Parametros', { chave: chave, valor: valor, atualizadoEm: agora_() });
  });
}

/* ===================== Validação ===================== */

function validar_(d) {
  d = d || {};
  const pagamento = String(d.pagamento), risco = String(d.risco), indexador = String(d.indexador), ir = String(d.ir);
  if (['juros', 'bullet', 'amort'].indexOf(pagamento) < 0) throw new Error('Tipo de pagamento inválido.');
  if (['A', 'B', 'C', 'D', 'E'].indexOf(risco) < 0) throw new Error('Risco inválido.');
  if (['cdi', 'ipca', 'pre'].indexOf(indexador) < 0) throw new Error('Indexador inválido.');
  if (['isento', 'regressivo'].indexOf(ir) < 0) throw new Error('Imposto de renda inválido.');
  const prazo = parseInt(d.prazoMeses, 10), taxa = Number(d.taxa), valor = Number(d.valor);
  if (!(prazo >= 1 && prazo <= 600)) throw new Error('Prazo inválido (1 a 600 meses).');
  if (!isFinite(taxa) || taxa < 0 || taxa > 200) throw new Error('Taxa inválida.');
  if (!(valor > 0)) throw new Error('Informe o valor investido.');
  const dataInv = dataOk_(d.dataInvestimento, 'Data do investimento');
  let venc = d.vencimento ? dataOk_(d.vencimento, 'Vencimento') : somarMeses_(dataInv, prazo);
  if (venc <= dataInv) throw new Error('O vencimento precisa ser depois da data do investimento.');
  let proxima = '';
  if (pagamento !== 'bullet') {
    proxima = dataOk_(d.proximaParcela, 'Próxima parcela');
    if (proxima < dataInv) throw new Error('A próxima parcela não pode ser antes do investimento.');
    if (proxima > venc) proxima = venc;
  } else { proxima = venc; }
  return { nome: String(d.nome || '').trim().slice(0, 80) || 'Investimento', pagamento: pagamento, risco: risco, prazoMeses: prazo,
           indexador: indexador, taxa: taxa, ir: ir, proximaParcela: proxima, valor: valor, dataInvestimento: dataInv, vencimento: venc };
}
function dataOk_(v, rotulo) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(new Date(s + 'T00:00:00Z').getTime())) throw new Error(rotulo + ' inválida.');
  return s;
}
function somarMeses_(iso, n) {
  const p = iso.split('-').map(Number), dia = p[2];
  const ult = new Date(Date.UTC(p[0], p[1] - 1 + n + 1, 0)).getUTCDate();
  return Utilities.formatDate(new Date(Date.UTC(p[0], p[1] - 1 + n, Math.min(dia, ult))), 'UTC', 'yyyy-MM-dd');
}

/* ===================== Sessão / segurança ===================== */

function hash_(texto, salt) {
  let h = salt + texto;
  for (let i = 0; i < (salt === 'tk' ? 1 : ITER_HASH); i++) h = b64_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt));
  return h;
}
function b64_(bytes) { return Utilities.base64Encode(bytes); }
function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function criarSessao_(userId) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  const exp = new Date(Date.now() + SESSAO_DIAS * 864e5).toISOString();
  inserir_('Sessoes', { tokenHash: hash_(token, 'tk'), userId: userId, criadoEm: agora_(), expiraEm: exp });
  return token;
}
function usuario_(token) {
  token = String(token || '');
  if (token.length < 20) throw new Error('SESSAO_EXPIRADA');
  const h = hash_(token, 'tk');
  const s = linhas_('Sessoes').filter(function (x) { return x.tokenHash === h; })[0];
  if (!s || new Date(s.expiraEm).getTime() < Date.now()) throw new Error('SESSAO_EXPIRADA');
  const u = linhas_('Usuarios').filter(function (x) { return x.id === s.userId; })[0];
  if (!u || u.ativo === false || u.ativo === 'FALSE') throw new Error('SESSAO_EXPIRADA');
  return u;
}
function limparSessoes_() {
  const agoraMs = Date.now();
  linhas_('Sessoes').filter(function (s) { return new Date(s.expiraEm).getTime() < agoraMs; }).reverse()
    .forEach(function (s) { sh_('Sessoes').deleteRow(s._row); });
}
function seguro_(fn) {
  try { return fn(); }
  catch (e) { return { ok: false, erro: String(e && e.message || e) }; }
}
function comLock_(fn) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function agora_() { return new Date().toISOString(); }

/* ===================== Camada de planilha ===================== */

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
function sh_(nome) { return ss_().getSheetByName(nome); }

function ensureSchema_(forcar) {
  const cache = CacheService.getScriptCache();
  if (!forcar && cache.get('schema_ok')) return;
  const ss = ss_();
  Object.keys(SCHEMA).forEach(function (nome) {
    const cols = SCHEMA[nome];
    let sh = ss.getSheetByName(nome);
    if (!sh) sh = ss.insertSheet(nome);
    if (sh.getMaxColumns() < cols.length) sh.insertColumnsAfter(sh.getMaxColumns(), cols.length - sh.getMaxColumns());
    const cab = sh.getRange(1, 1, 1, cols.length);
    cab.setValues([cols]).setFontWeight('bold').setBackground('#1f2125').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    cols.forEach(function (c, i) { if (COLUNAS_TEXTO.indexOf(c) >= 0) sh.getRange(2, i + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@'); });
  });
  cache.put('schema_ok', '1', 6 * 3600);
}

/** Lê a aba inteira como lista de objetos (com _row = número da linha). */
function linhas_(nome) {
  const sh = sh_(nome), cols = SCHEMA[nome];
  const n = sh.getLastRow();
  if (n < 2) return [];
  return sh.getRange(2, 1, n - 1, cols.length).getValues().map(function (v, i) {
    const o = { _row: i + 2 };
    cols.forEach(function (c, j) { o[c] = norm_(v[j]); });
    return o;
  });
}
function norm_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return v;
}
function inserir_(nome, obj) {
  const sh = sh_(nome), cols = SCHEMA[nome];
  const linha = sh.getLastRow() + 1;
  sh.getRange(linha, 1, 1, cols.length).setNumberFormats([cols.map(function (c) { return COLUNAS_TEXTO.indexOf(c) >= 0 ? '@' : 'General'; })])
    .setValues([cols.map(function (c) { return obj[c] === undefined ? '' : obj[c]; })]);
}
function atualizar_(nome, row, parcial) {
  const sh = sh_(nome), cols = SCHEMA[nome];
  Object.keys(parcial).forEach(function (k) {
    const i = cols.indexOf(k);
    if (i >= 0) sh.getRange(row, i + 1).setValue(parcial[k]);
  });
}
function paraCliente_(i) {
  return { id: i.id, nome: i.nome, pagamento: i.pagamento, risco: i.risco, prazoMeses: Number(i.prazoMeses), indexador: i.indexador,
           taxa: Number(i.taxa), ir: i.ir, proximaParcela: i.proximaParcela, valor: Number(i.valor),
           dataInvestimento: i.dataInvestimento, vencimento: i.vencimento };
}
