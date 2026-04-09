import { spawn, execSync, type ChildProcess } from 'child_process';
import { SCREEN_RECORD_FPS } from './config.js';

export interface ScreenRecorder {
  stop: () => Promise<void>;
  filePath: string;
}

interface MonitorInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

/**
 * Probe the ACTUAL native desktop size by asking ffmpeg.
 * This bypasses all DPI scaling issues.
 */
function probeDesktopSize(): { w: number; h: number } | null {
  try {
    const out = execSync(
      'ffmpeg -f gdigrab -i desktop -frames:v 1 -f null - 2>&1',
      { encoding: 'utf8', timeout: 8000, shell: true as any },
    );
    const m = out.match(/(\d{3,5})x(\d{3,5})/);
    if (m) return { w: parseInt(m[1]!, 10), h: parseInt(m[2]!, 10) };
  } catch (e) {
    // Try parsing stderr from the error
    const msg = (e as any)?.stderr || (e as any)?.stdout || String(e);
    const m = msg.match(/(\d{3,5})x(\d{3,5})/);
    if (m) return { w: parseInt(m[1]!, 10), h: parseInt(m[2]!, 10) };
  }
  return null;
}


/**
 
 */
function getAllMonitors(): MonitorInfo[] {
  try {
    const script = [
      'Add-Type -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();\' -Name U -Namespace W',
      '[W.U]::SetProcessDPIAware() | Out-Null',
      'Add-Type -AssemblyName System.Windows.Forms',
      '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {',
      '  "$($_.Bounds.X) $($_.Bounds.Y) $($_.Bounds.Width) $($_.Bounds.Height) $($_.Primary)"',
      '}',
    ].join('\n');
    // -EncodedCommand avoids escaping hell and stdin-pipe hangs on Windows
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const raw = execSync(`powershell -NoProfile -EncodedCommand ${b64}`, {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
    const monitors: MonitorInfo[] = [];
    for (const line of raw.split('\n')) {
      const p = line.trim().split(' ');
      if (p.length >= 5) {
        monitors.push({
          x: parseInt(p[0]!, 10), y: parseInt(p[1]!, 10),
          width: parseInt(p[2]!, 10), height: parseInt(p[3]!, 10),
          primary: p[4] === 'True',
        });
      }
    }
    return monitors;
  } catch { return []; }
}

/**
 * Detect primary monitor.
 */
function getPrimaryMonitor(): MonitorInfo | null {
  return getAllMonitors().find(m => m.primary) ?? null;
}

export function startScreenRecording(
  outputPath: string,
  opts?: { fps?: number },
): ScreenRecorder {
  const fps = opts?.fps ?? SCREEN_RECORD_FPS;
  const monitor = getPrimaryMonitor();

  const args = [
    '-y',
    '-thread_queue_size', '1024',
    '-f', 'gdigrab',
    '-framerate', String(fps),
  ];

  // Isolate the primary monitor. gdigrab uses PHYSICAL pixel
  // coordinates, so getAllMonitors() calls SetProcessDPIAware()
  // to get physical bounds that match what ffmpeg sees.
  if (monitor) {
    args.push(
      '-offset_x', String(monitor.x),
      '-offset_y', String(monitor.y),
      '-video_size', `${monitor.width}x${monitor.height}`,
    );
  }

  args.push(
    '-i', 'desktop',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '20',
    '-g', '30',
    '-pix_fmt', 'yuv420p',
    '-movflags', 'frag_keyframe+empty_moov',
    outputPath,
  );

  const proc: ChildProcess = spawn('ffmpeg', args, {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderrBuf = '';
  proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString(); });
  proc.on('error', (err) => {
    console.error('[screen-recorder] spawn error:', err.message);
  });
  proc.on('close', (code) => {
    if (code !== 0 && stderrBuf) {
      console.error('[screen-recorder] ffmpeg exited with code', code);
      console.error('[screen-recorder] stderr:', stderrBuf.slice(-500));
    }
  });

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      if (proc.killed || proc.exitCode !== null) {
        resolve();
        return;
      }
      proc.on('close', () => resolve());
      proc.stdin?.write('q');
      proc.stdin?.end();
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 5_000);
    });

  return { stop, filePath: outputPath };
}
