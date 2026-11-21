'use strict';
/* Impressão direta na térmica (ESC/POS) pelo Windows — usada pelo servidor e pelos caixas da rede */
const fs = require('fs'), path = require('path'), os = require('os');
const { spawn } = require('child_process');
module.exports = function impressao({ DATA, log, J }) {
const CP850 = { 'á': 0xa0, 'à': 0x85, 'â': 0x83, 'ã': 0xc6, 'é': 0x82, 'ê': 0x88, 'í': 0xa1, 'ó': 0xa2, 'ô': 0x93, 'õ': 0xe4, 'ú': 0xa3, 'ü': 0x81, 'ç': 0x87, 'Á': 0xb5, 'À': 0xb7, 'Â': 0xb6, 'Ã': 0xc7, 'É': 0x90, 'Ê': 0xd2, 'Í': 0xd6, 'Ó': 0xe0, 'Ô': 0xe2, 'Õ': 0xe5, 'Ú': 0xe9, 'Ç': 0x80, 'º': 0xa7, 'ª': 0xa6 };
function enc(s, ascii) {
  s = String(s ?? '').replace(/ /g, ' ').replace(/[×✕]/g, 'x').replace(/[−–—]/g, '-').replace(/[·•]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...');
  if (ascii) s = s.replace(/º/g, 'o').replace(/ª/g, 'a').replace(/°/g, 'o');
  const out = [];
  for (const ch of s) {
    if (ch == '\n') { out.push(10); continue }
    const c = ch.charCodeAt(0);
    if (c >= 32 && c < 127) { out.push(c); continue }
    if (!ascii && CP850[ch]) { out.push(CP850[ch]); continue }
    const b = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out.push(b.length == 1 && b.charCodeAt(0) < 127 ? b.charCodeAt(0) : 63);
  }
  return Buffer.from(out);
}
function wrap(s, w) {
  const out = []; for (const par of String(s ?? '').split('\n')) {
    let line = ''; for (const word of par.split(/\s+/).filter(Boolean)) {
      let wd = word; while (wd.length > w) { if (line) { out.push(line); line = '' } out.push(wd.slice(0, w)); wd = wd.slice(w) }
      if (!line) line = wd; else if ((line + ' ' + wd).length <= w) line += ' ' + wd; else { out.push(line); line = wd }
    } out.push(line);
  } return out;
}
function escpos(spec, o) {
  const cols = +o.cols || 48, ascii = o.ascii !== false, parts = [];
  const B = (...b) => parts.push(Buffer.from(b)), T = s => parts.push(enc(s, ascii));
  const al = a => B(0x1b, 0x61, a == 'c' ? 1 : a == 'r' ? 2 : 0), bold = v => B(0x1b, 0x45, v ? 1 : 0), size = s => B(0x1d, 0x21, s == 2 ? 0x11 : 0);
  B(0x1b, 0x40); if (!ascii) B(0x1b, 0x74, 2);
  for (const it of spec || []) {
    if (!it) continue;
    if (it.logo) continue;
    if (it.qr) {   // QR Code nativo da impressora (GS ( k), modelo 2
      const d = Buffer.from(String(it.qr), 'latin1'), n = d.length + 3; al('c');
      B(0x1d, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0); B(0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x43, Math.min(8, Math.max(3, +it.mod || 4))); B(0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31);
      B(0x1d, 0x28, 0x6b, n & 255, n >> 8, 0x31, 0x50, 0x30); parts.push(d); B(0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); T('\n'); continue;
    }
    if (it.hr) { al('l'); size(1); bold(0); T('-'.repeat(cols) + '\n'); continue }
    if (it.gap) { T('\n'.repeat(Math.min(10, +it.gap || 1))); continue }
    if (it.box) { al('c'); bold(0); size(1); T('='.repeat(cols) + '\n'); bold(1); size(2); wrap(it.box, Math.floor(cols / 2)).forEach(l => T(l + '\n')); size(1); bold(0); T('='.repeat(cols) + '\n'); continue }
    const w = it.s == 2 ? Math.floor(cols / 2) : cols;
    size(it.s); bold(it.b);
    if (it.lr) {
      al('l'); const L = String(it.lr[0] ?? ''), Rt = String(it.lr[1] ?? '').replace(/ /g, ' ');
      const ls = wrap(L, Math.max(4, w - Rt.length - 1));
      ls.forEach((l, i) => T(i == ls.length - 1 ? l + ' '.repeat(Math.max(1, w - l.length - Rt.length)) + Rt + '\n' : l + '\n'));
    } else { al(it.a == 'c' ? 'c' : it.a == 'r' ? 'r' : 'l'); wrap(it.t, w).forEach(l => T(l + '\n')) }
    size(1); bold(0);
  }
  al('l'); T('\n\n\n\n'); B(0x1d, 0x56, 0x42, 0x00);
  if (o.drawer) B(0x1b, 0x70, 0x00, 0x19, 0xfa);
  return Buffer.concat(parts);
}
const PS1 = `param([string]$p,[string]$f)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class RawPrn {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public class DOCINFO { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }
 [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
 [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
 [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)] public static extern int StartDocPrinter(IntPtr h, int l, [In] DOCINFO di);
 [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
 [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
 [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
 [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] b, int c, out int w);
 public static void Send(string p, byte[] b) {
  IntPtr h; if (!OpenPrinter(p, out h, IntPtr.Zero)) throw new Exception("Impressora nao encontrada: " + p);
  try { var di = new DOCINFO(); di.pDocName = "Cupom PDV"; di.pDataType = "RAW";
   if (StartDocPrinter(h, 1, di) == 0) throw new Exception("Nao foi possivel iniciar a impressao");
   StartPagePrinter(h); int w; WritePrinter(h, b, b.Length, out w); EndPagePrinter(h); EndDocPrinter(h);
  } finally { ClosePrinter(h); } } }
"@
[RawPrn]::Send($p, [IO.File]::ReadAllBytes($f))
`;
const PS1F = path.join(DATA, 'raw-print.ps1');
try { fs.writeFileSync(PS1F, PS1) } catch (e) { }
function ps(args) {
  return new Promise((res, rej) => {
    if (process.platform != 'win32') return rej(new Error('A impressão direta só funciona no Windows.'));
    const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args], { windowsHide: true });
    let out = '', er = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => er += d);
    p.on('error', rej); p.on('close', c => c ? rej(new Error((er.split('\n').find(l => /Exception|nao|não/i.test(l)) || er || 'Falha no PowerShell').trim().slice(0, 200))) : res(out));
  });
}
let printQ = Promise.resolve();
function sendRaw(name, buf) {
  const job = printQ.then(async () => {
    const f = path.join(os.tmpdir(), 'pdv-cupom-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.bin');
    fs.writeFileSync(f, buf);
    try { await ps(['-File', PS1F, '-p', name, '-f', f]) } finally { fs.unlink(f, () => { }) }
  });
  printQ = job.catch(() => { }); return job;
}
async function printers() {
  if (process.platform != 'win32') return [];
  const out = await ps(['-Command', 'Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json']);
  const j = J(out.trim()); return Array.isArray(j) ? j : j ? [j] : [];
}


  return { escpos, sendRaw, printers };
};
