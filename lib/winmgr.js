// Gerenciador de janelas do Windows: lista monitores e janelas (em ordem de profundidade, a mais recente
// primeiro), move/redimensiona/maximiza/foca. Um PowerShell fica aberto com uma classe C# (API user32/dwmapi);
// cada pedido é uma linha "id comando args" no stdin e a resposta volta como uma linha "id json".
// Coordenadas em pixels físicos (o processo é DPI-aware).
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Diagnostics; using System.Runtime.InteropServices;
public static class JW {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public delegate bool MonProc(IntPtr m, IntPtr dc, ref RECT r, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX mi);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT p, uint f);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);

  static string Esc(string s) {
    var b = new StringBuilder();
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }
  static string R(RECT r) { return r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T); }

  static List<IntPtr> mons = new List<IntPtr>();
  public static string List() {
    mons.Clear();
    var sb = new StringBuilder("{\"monitors\":[");
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr m, IntPtr dc, ref RECT r, IntPtr l) { mons.Add(m); return true; }, IntPtr.Zero);
    for (int i = 0; i < mons.Count; i++) {
      var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      GetMonitorInfo(mons[i], ref mi);
      if (i > 0) sb.Append(',');
      sb.Append("{\"i\":" + i + ",\"device\":\"" + Esc(mi.szDevice) + "\",\"primary\":" + ((mi.dwFlags & 1) != 0 ? "true" : "false")
        + ",\"rect\":[" + R(mi.rcMonitor) + "],\"work\":[" + R(mi.rcWork) + "]}");
    }
    POINT cp; GetCursorPos(out cp);
    sb.Append("],\"cursor\":" + mons.IndexOf(MonitorFromPoint(cp, 2)) + ",\"foreground\":" + GetForegroundWindow().ToInt64() + ",\"windows\":[");
    bool first = true;
    var names = new Dictionary<uint, string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0) return true;                       // WS_EX_TOOLWINDOW
      if (GetWindow(h, 4) != IntPtr.Zero && (ex & 0x40000) == 0) return true; // tem dono e não é APPWINDOW
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4); // janelas "fantasmas" de apps UWP
      if (cloaked != 0) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string pn;
      if (!names.TryGetValue(pid, out pn)) { try { pn = Process.GetProcessById((int)pid).ProcessName; } catch { pn = ""; } names[pid] = pn; }
      RECT r; GetWindowRect(h, out r);
      if (!first) sb.Append(','); first = false;
      sb.Append("{\"h\":" + h.ToInt64() + ",\"title\":\"" + Esc(t.ToString()) + "\",\"proc\":\"" + Esc(pn) + "\",\"pid\":" + pid
        + ",\"rect\":[" + R(r) + "],\"min\":" + (IsIconic(h) ? "true" : "false") + ",\"max\":" + (IsZoomed(h) ? "true" : "false")
        + ",\"mon\":" + mons.IndexOf(MonitorFromWindow(h, 2)) + "}");
      return true;
    }, IntPtr.Zero);
    sb.Append("]}");
    return sb.ToString();
  }

  // traz para frente mesmo quando o JARVIS não é a janela ativa (o "toque" no ALT libera o SetForegroundWindow)
  public static void Front(IntPtr h) {
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
  }

  // x,y,w,h = área VISÍVEL desejada; compensa a borda invisível do Windows 10 (senão sobram frestas de ~7 px)
  public static string Move(IntPtr h, int x, int y, int w, int hh, bool max) {
    if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, 9);
    RECT wr, fr; GetWindowRect(h, out wr);
    int dl = 0, dt = 0, dr = 0, db = 0;
    if (DwmGetWindowAttribute(h, 9, out fr, Marshal.SizeOf(typeof(RECT))) == 0) {
      dl = fr.L - wr.L; dt = fr.T - wr.T; dr = wr.R - fr.R; db = wr.B - fr.B;
    }
    SetWindowPos(h, IntPtr.Zero, x - dl, y - dt, w + dl + dr, hh + dt + db, 0x0004 | 0x0010); // NOZORDER | NOACTIVATE
    if (max) ShowWindow(h, 3);
    Front(h);
    GetWindowRect(h, out wr);
    return "{\"ok\":true,\"rect\":[" + R(wr) + "]}";
  }

  public static string Show(IntPtr h, int cmd) {
    ShowWindow(h, cmd);
    if (cmd != 6) Front(h);
    return "{\"ok\":true}";
  }
}
'@
[JW]::SetProcessDPIAware() | Out-Null
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $a = $line.Split(' ')
  $out = '{"ok":false,"error":"comando desconhecido"}'
  try {
    switch ($a[1]) {
      'list' { $out = [JW]::List() }
      'move' { $out = [JW]::Move([IntPtr][long]$a[2], [int]$a[3], [int]$a[4], [int]$a[5], [int]$a[6], $a[7] -eq '1') }
      'show' { $out = [JW]::Show([IntPtr][long]$a[2], [int]$a[3]) }
    }
  } catch { $out = '{"ok":false,"error":"' + ($_.Exception.Message -replace '["\\]', ' ') + '"}' }
  [Console]::Out.WriteLine($a[0] + ' ' + $out)
}
`;

class WinMgr {
  constructor(dataDir) {
    this.scriptFile = path.join(dataDir, 'winmgr.ps1');
    this.proc = null;
    this.ready = null;
    this.waiters = new Map();
    this.seq = 0;
  }

  ensure() {
    if (this.proc && this.proc.exitCode === null) return this.ready;
    fs.writeFileSync(this.scriptFile, SCRIPT);
    const proc = spawn('powershell', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', this.scriptFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = proc;
    let buf = '';
    this.ready = new Promise((resolve) => {
      proc.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line === 'ready') { resolve(); continue; }
          const sp = line.indexOf(' ');
          const w = this.waiters.get(line.slice(0, sp));
          if (!w) continue;
          this.waiters.delete(line.slice(0, sp));
          try { w.resolve(JSON.parse(line.slice(sp + 1))); } catch (e) { w.reject(new Error('resposta inválida do Windows')); }
        }
      });
    });
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null;
      for (const w of this.waiters.values()) w.reject(new Error('o gerenciador de janelas fechou'));
      this.waiters.clear();
    });
    return this.ready;
  }

  async call(...args) {
    await this.ensure();
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      this.waiters.set(id, { resolve, reject });
      this.proc.stdin.write(`${id} ${args.join(' ')}\n`);
      setTimeout(() => { if (this.waiters.delete(id)) reject(new Error('o Windows demorou para responder')); }, 8000);
    });
  }

  async list() {
    const r = await this.call('list');
    const rect = ([x, y, w, h]) => ({ x, y, w, h });
    r.monitors = r.monitors.map((m) => ({ ...m, rect: rect(m.rect), work: rect(m.work), number: Number((m.device.match(/(\d+)$/) || [])[1]) || m.i + 1 }));
    r.windows = r.windows.map((w, z) => ({ ...w, rect: rect(w.rect), z }));
    return r;
  }
  move(h, { x, y, w, h: hh }, maximize = false) { return this.call('move', h, Math.round(x), Math.round(y), Math.round(w), Math.round(hh), maximize ? 1 : 0); }
  minimize(h) { return this.call('show', h, 6); }
  maximize(h) { return this.call('show', h, 3); }
  restore(h) { return this.call('show', h, 9); }

  stop() { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); this.proc = null; } }
}

module.exports = { WinMgr };
