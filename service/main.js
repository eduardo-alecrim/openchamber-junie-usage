// src/shared.ts
import http from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
var langOf = (locale) => locale?.toLowerCase().startsWith("pt") ? "pt" : "en";

class CliError extends Error {
  stdout;
  stderr;
  timedOut;
  code;
  constructor(message, stdout, stderr, timedOut, code) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
    this.timedOut = timedOut;
    this.code = code;
  }
}
var runCli = (command, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: tmpdir(), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      const timedOut = error.killed === true;
      reject(new CliError(timedOut ? `${command} did not answer within ${timeoutMs / 1000}s` : error.message, String(stdout), String(stderr), timedOut, error.code ?? null));
      return;
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});
var cachedRead = (ttlMs, read, now = Date.now) => {
  let last = null;
  let running = null;
  return (force = false) => {
    if (!force && last && now() - last.at < ttlMs)
      return Promise.resolve(last.value);
    if (running)
      return running;
    running = read().then((value) => {
      last = { at: now(), value };
      return value;
    }).finally(() => {
      running = null;
    });
    return running;
  };
};
var formatDateTime = (at, locale) => {
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(at);
  } catch {
    return new Date(at).toISOString();
  }
};
var send = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});
var readActionEvent = (body) => {
  try {
    const value = JSON.parse(body);
    if (typeof value !== "object" || value === null)
      return null;
    const { id, value: chosen } = value;
    if (typeof id !== "string" || id.length === 0)
      return null;
    return typeof chosen === "string" ? { id, value: chosen } : { id };
  } catch {
    return null;
  }
};
var serveStatusSection = (handlers, env = process.env) => {
  const port = Number(env.OPENCHAMBER_SERVICE_PORT);
  const token = env.OPENCHAMBER_SERVICE_TOKEN ?? "";
  if (!port || !token) {
    console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== "/status") {
      send(res, 404, { error: "not-found" });
      return;
    }
    if (req.method === "GET") {
      handlers.render(url.searchParams.get("locale") || "en").then((view) => send(res, 200, view), (error) => send(res, 500, { message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    if (req.method === "POST") {
      readBody(req).then(async (body) => {
        const event = readActionEvent(body);
        if (!event) {
          send(res, 400, { message: "not a status action" });
          return;
        }
        await handlers.act(event);
        send(res, 200, {});
      }).catch((error) => send(res, 500, { message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    send(res, 405, { error: "method-not-allowed" });
  });
  server.listen(port, "127.0.0.1");
  return server;
};

// src/usage.ts
var JUNIE_QUOTA_ARGS = ["api", "post", "/api/rpc/jetbrains-junie/quota", "--data", '{"input":{}}'];
var asRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
var asText = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
var parseJunieBalance = (stdout, now = Date.now()) => {
  let json = null;
  try {
    json = asRecord(JSON.parse(stdout.trim()));
  } catch {}
  const output = asRecord(json?.output);
  if (!output) {
    const message = asText(asRecord(json?.error)?.message) ?? asText(json?.message);
    return { state: "error", message: message ?? "opencode did not answer the Junie quota call with JSON" };
  }
  const observed = Date.parse(asText(output.observedAt) ?? "");
  const observedAt = Number.isFinite(observed) ? observed : now;
  const license = asText(output.license);
  if (output.state === "available") {
    const amount = output.amount;
    const unit = output.unit;
    if (typeof amount !== "number" || !Number.isFinite(amount) || unit !== "credits" && unit !== "USD") {
      return { state: "error", message: "the Junie quota answer has no usable amount" };
    }
    return { state: "available", amount, unit, license, observedAt };
  }
  if (output.state === "unavailable")
    return { state: "unavailable", reason: asText(output.reason) ?? "unknown", license, observedAt };
  return { state: "error", message: `unknown Junie quota state ${JSON.stringify(output.state)}` };
};
var REASONS = {
  pt: {
    inactive: "A conta JetBrains não está ativa.",
    "unsupported-license": "Esta licença não informa saldo.",
    "unsupported-unit": "A JetBrains informou o saldo numa unidade desconhecida.",
    "missing-balance": "A JetBrains não informou o saldo.",
    "invalid-response": "A JetBrains respondeu num formato inesperado.",
    "invalid-context": "O plugin do Junie não tem uma conexão ativa.",
    "invalid-credentials": "O login do Junie é inválido. Entre de novo pelo OpenCode.",
    unauthorized: "O login do Junie expirou. Entre de novo pelo OpenCode.",
    "rate-limited": "A JetBrains limitou as consultas. Tente mais tarde.",
    "http-error": "A JetBrains respondeu com erro.",
    "network-error": "Sem conexão com a JetBrains.",
    "body-too-large": "A resposta da JetBrains veio grande demais.",
    timeout: "A JetBrains demorou demais para responder.",
    cancelled: "A consulta foi cancelada."
  },
  en: {
    inactive: "The JetBrains account is not active.",
    "unsupported-license": "This license reports no balance.",
    "unsupported-unit": "JetBrains reported the balance in an unknown unit.",
    "missing-balance": "JetBrains reported no balance.",
    "invalid-response": "JetBrains answered in an unexpected format.",
    "invalid-context": "The Junie plugin has no active connection.",
    "invalid-credentials": "The Junie login is invalid. Sign in again through OpenCode.",
    unauthorized: "The Junie login expired. Sign in again through OpenCode.",
    "rate-limited": "JetBrains is rate limiting balance reads. Try again later.",
    "http-error": "JetBrains answered with an error.",
    "network-error": "Could not reach JetBrains.",
    "body-too-large": "JetBrains sent too large an answer.",
    timeout: "JetBrains took too long to answer.",
    cancelled: "The read was cancelled."
  }
};
var TEXT = {
  pt: {
    balance: "Saldo",
    credits: "créditos",
    license: (license) => `Licença ${license}`,
    hint: "A JetBrains informa só o saldo restante, sem o total do plano nem a data de renovação.",
    noOpencode: "Não encontrei o opencode no PATH do OpenChamber.",
    error: (message) => `Não consegui ler o saldo: ${message}`,
    unknown: (reason) => `Saldo indisponível (${reason}).`,
    refresh: "Atualizar",
    readAt: (at) => `Lido em ${at}`
  },
  en: {
    balance: "Balance",
    credits: "credits",
    license: (license) => `License ${license}`,
    hint: "JetBrains reports only the balance left, not the plan total or a renewal date.",
    noOpencode: "opencode was not found on OpenChamber's PATH.",
    error: (message) => `Could not read the balance: ${message}`,
    unknown: (reason) => `Balance unavailable (${reason}).`,
    refresh: "Refresh",
    readAt: (at) => `Read at ${at}`
  }
};
var formatAmount = (amount, unit, locale, lang) => {
  try {
    if (unit === "USD")
      return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount);
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount)} ${TEXT[lang].credits}`;
  } catch {
    return `${amount.toFixed(2)} ${unit === "USD" ? "USD" : TEXT[lang].credits}`;
  }
};
var renderJunieBalance = (balance, lang, locale) => {
  const t = TEXT[lang];
  const controls = [{ kind: "button", id: "refresh", label: t.refresh }];
  const note = (id, text, tone) => ({ rows: [{ kind: "note", id, text: text.slice(0, 300), tone }], controls });
  switch (balance.state) {
    case "no-opencode":
      return note("no-opencode", t.noOpencode, "error");
    case "error":
      return note("error", t.error(balance.message), "error");
    case "unavailable":
      return note("unavailable", REASONS[lang][balance.reason] ?? t.unknown(balance.reason), "warning");
  }
  return {
    rows: [
      {
        kind: "line",
        id: "balance",
        label: t.balance,
        icon: "coins",
        value: formatAmount(balance.amount, balance.unit, locale, lang),
        valueTone: balance.amount <= 0 ? "error" : "default",
        badge: balance.license ? { label: t.license(balance.license).slice(0, 60), tone: "muted" } : undefined,
        tooltip: t.hint
      },
      { kind: "note", id: "read-at", text: t.readAt(formatDateTime(balance.observedAt, locale)), tone: "muted" }
    ],
    controls
  };
};

// service/main.ts
var TTL_MS = 2 * 60000;
var TIMEOUT_MS = 30000;
var readBalance = async () => {
  try {
    const { stdout } = await runCli("opencode", JUNIE_QUOTA_ARGS, TIMEOUT_MS);
    return parseJunieBalance(stdout);
  } catch (error) {
    if (error instanceof CliError) {
      if (error.code === "ENOENT")
        return { state: "no-opencode" };
      const parsed = parseJunieBalance(error.stdout);
      if (parsed.state !== "error")
        return parsed;
      const detail = error.stderr.trim().split(`
`)[0];
      if (detail)
        return { state: "error", message: detail.slice(0, 200) };
    }
    return { state: "error", message: error instanceof Error ? error.message : String(error) };
  }
};
var read = cachedRead(TTL_MS, readBalance);
serveStatusSection({
  render: async (locale) => renderJunieBalance(await read(), langOf(locale), locale),
  act: async (event) => {
    if (event.id === "refresh")
      await read(true);
  }
});
