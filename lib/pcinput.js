// Controle de mouse e teclado do Windows (para o touchpad do celular).
// Um PowerShell fica aberto com uma classe C# que chama a API do Windows; cada comando é uma linha no stdin,
// então a latência é de milissegundos (abrir um processo por comando seria lento demais para mover o mouse).
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class JarvisInput {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out P p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint f, UIntPtr e);
  public struct P { public int X; public int Y; }
  public static void Move(int dx, int dy) { P p; GetCursorPos(out p); SetCursorPos(p.X + dx, p.Y + dy); }
  public static void To(int x, int y) { SetCursorPos(x, y); }
  public static void Click(int b) {
    uint down = b == 1 ? 0x0008u : 0x0002u, up = b == 1 ? 0x0010u : 0x0004u;
    mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Scroll(int amount) { mouse_event(0x0800, 0, 0, amount, UIntPtr.Zero); }
  public static void Key(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
'@
[JarvisInput]::SetProcessDPIAware() | Out-Null
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $a = $line.Split(' ')
  switch ($a[0]) {
    'm' { [JarvisInput]::Move([int]$a[1], [int]$a[2]) }
    't' { [JarvisInput]::To([int]$a[1], [int]$a[2]) }
    'c' { [JarvisInput]::Click([int]$a[1]) }
    's' { [JarvisInput]::Scroll([int]$a[1]) }
    'k' { [JarvisInput]::Key([byte]$a[1]) }
    'w' {
      $txt = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($a[1]))
      # caracteres especiais do SendKeys precisam ir entre chaves
      [System.Windows.Forms.SendKeys]::SendWait(($txt -replace '([+^%~(){}\[\]])', '{$1}'))
    }
  }
}
`;

// Teclas virtuais do Windows
const KEYS = {
  media_prev: 0xb1, media_play: 0xb3, media_next: 0xb0,
  vol_down: 0xae, vol_mute: 0xad, vol_up: 0xaf,
  enter: 0x0d, backspace: 0x08, esc: 0x1b, tab: 0x09,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, space: 0x20,
};

class PcInput {
  constructor(dataDir) {
    this.scriptFile = path.join(dataDir, 'pcinput.ps1');
    this.proc = null;
  }

  ensure() {
    if (this.proc && this.proc.exitCode === null) return;
    fs.writeFileSync(this.scriptFile, SCRIPT);
    this.proc = spawn('powershell', ['-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', this.scriptFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc.on('exit', () => { this.proc = null; });
  }

  write(line) {
    this.ensure();
    this.proc.stdin.write(`${line}\n`);
  }

  move(dx, dy) { if (dx || dy) this.write(`m ${Math.round(dx)} ${Math.round(dy)}`); }
  moveTo(x, y) { this.write(`t ${Math.round(x)} ${Math.round(y)}`); }
  click(button = 'left') { this.write(`c ${button === 'right' ? 1 : 0}`); }
  scroll(amount) { this.write(`s ${Math.round(amount)}`); }
  type(text) { this.write(`w ${Buffer.from(String(text).slice(0, 500), 'utf8').toString('base64')}`); }
  key(name) {
    if (name === 'lock') { exec('rundll32.exe user32.dll,LockWorkStation'); return; }
    const vk = KEYS[name];
    if (vk) this.write(`k ${vk}`);
  }

  stop() { if (this.proc) { this.proc.stdin.end(); this.proc.kill(); this.proc = null; } }
}

module.exports = { PcInput };
