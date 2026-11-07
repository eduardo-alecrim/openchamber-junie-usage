// What both services share: running an official CLI, caching its answer, and
// serving a Work Status section (`statusSection.source`) on the loopback port
// OpenChamber hands the service.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { GuestStatusActionEvent, GuestStatusTone, GuestStatusView } from '@openchamber/sdk';

export type Lang = 'pt' | 'en';

export const langOf = (locale: string | null | undefined): Lang => (locale?.toLowerCase().startsWith('pt') ? 'pt' : 'en');

export class CliError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly timedOut: boolean,
    /** `ENOENT` when the command is not on PATH, else the exit code. */
    readonly code: string | number | null,
  ) {
    super(message);
  }
}

/** Runs a CLI without a shell, from the temp directory, and resolves its stdout. */
export const runCli = (command: string, args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { cwd: tmpdir(), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = error.killed === true;
        reject(new CliError(timedOut ? `${command} did not answer within ${timeoutMs / 1000}s` : error.message, String(stdout), String(stderr), timedOut, (error as NodeJS.ErrnoException).code ?? null));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** One read at a time, reused for `ttlMs`; `force` reads again but still joins a read under way. */
export const cachedRead = <T>(ttlMs: number, read: () => Promise<T>, now: () => number = Date.now) => {
  let last: { at: number; value: T } | null = null;
  let running: Promise<T> | null = null;
  return (force = false): Promise<T> => {
    if (!force && last && now() - last.at < ttlMs) return Promise.resolve(last.value);
    if (running) return running;
    running = read()
      .then((value) => {
        last = { at: now(), value };
        return value;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
};

/** Theme tone for a remaining share, 0..100. */
export const toneForRemaining = (remainingPercent: number): GuestStatusTone =>
  remainingPercent <= 10 ? 'error' : remainingPercent <= 30 ? 'warning' : 'success';

/** "in 4 h 59 min" / "em 4 h 59 min", from now to `resetAt` (epoch ms). */
export const formatCountdown = (resetAt: number, now: number, lang: Lang): string => {
  const minutes = Math.max(0, Math.round((resetAt - now) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = days > 0 ? [`${days} d`, `${hours} h`] : hours > 0 ? [`${hours} h`, `${mins} min`] : [`${mins} min`];
  return `${lang === 'pt' ? 'em' : 'in'} ${parts.join(' ')}`;
};

export const formatDateTime = (at: number, locale: string): string => {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
};

export type StatusHandlers = {
  /** The section's rows; `locale` is the app's, when the host sends one. */
  render: (locale: string) => Promise<GuestStatusView>;
  /** A header control or row action the user activated. */
  act: (event: GuestStatusActionEvent) => Promise<void>;
};

const send = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const readActionEvent = (body: string): GuestStatusActionEvent | null => {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== 'object' || value === null) return null;
    const { id, value: chosen } = value as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0) return null;
    return typeof chosen === 'string' ? { id, value: chosen } : { id };
  } catch {
    return null;
  }
};

/** Serves `GET /health`, `GET /status` and `POST /status` behind the service bearer. */
export const serveStatusSection = (handlers: StatusHandlers, env: NodeJS.ProcessEnv = process.env): http.Server => {
  const port = Number(env.OPENCHAMBER_SERVICE_PORT);
  const token = env.OPENCHAMBER_SERVICE_TOKEN ?? '';
  if (!port || !token) {
    console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== '/status') {
      send(res, 404, { error: 'not-found' });
      return;
    }
    if (req.method === 'GET') {
      handlers.render(url.searchParams.get('locale') || 'en').then(
        (view) => send(res, 200, view),
        (error: unknown) => send(res, 500, { message: error instanceof Error ? error.message : String(error) }),
      );
      return;
    }
    if (req.method === 'POST') {
      readBody(req)
        .then(async (body) => {
          const event = readActionEvent(body);
          if (!event) {
            send(res, 400, { message: 'not a status action' });
            return;
          }
          await handlers.act(event);
          send(res, 200, {});
        })
        .catch((error: unknown) => send(res, 500, { message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    send(res, 405, { error: 'method-not-allowed' });
  });
  server.listen(port, '127.0.0.1');
  return server;
};
