// Junie credit balance, as the opencode-jetbrains-junie-oauth plugin reports it:
//
//   opencode api post /api/rpc/jetbrains-junie/quota --data '{"input":{}}'
//
// The plugin holds the JetBrains login and asks JetBrains for the balance; this
// service only reads the plugin's answer. JetBrains reports the balance left,
// not the plan total or a renewal date, so it is shown as an amount, never as a
// share.
import type { GuestStatusView } from '@openchamber/sdk';
import { formatDateTime, type Lang } from './shared.ts';

export const JUNIE_QUOTA_ARGS = ['api', 'post', '/api/rpc/jetbrains-junie/quota', '--data', '{"input":{}}'] as const;

export type JunieBalance =
  | { state: 'available'; amount: number; unit: 'credits' | 'USD'; license: string | null; observedAt: number }
  | { state: 'unavailable'; reason: string; license: string | null; observedAt: number }
  | { state: 'error'; message: string };

export type ReadFailure = { state: 'no-opencode' };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asText = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

export const parseJunieBalance = (stdout: string, now: number = Date.now()): JunieBalance => {
  let json: Record<string, unknown> | null = null;
  try {
    json = asRecord(JSON.parse(stdout.trim()));
  } catch {
    // below
  }
  const output = asRecord(json?.output);
  if (!output) {
    const message = asText(asRecord(json?.error)?.message) ?? asText(json?.message);
    return { state: 'error', message: message ?? 'opencode did not answer the Junie quota call with JSON' };
  }
  const observed = Date.parse(asText(output.observedAt) ?? '');
  const observedAt = Number.isFinite(observed) ? observed : now;
  const license = asText(output.license);
  if (output.state === 'available') {
    const amount = output.amount;
    const unit = output.unit;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || (unit !== 'credits' && unit !== 'USD')) {
      return { state: 'error', message: 'the Junie quota answer has no usable amount' };
    }
    return { state: 'available', amount, unit, license, observedAt };
  }
  if (output.state === 'unavailable') return { state: 'unavailable', reason: asText(output.reason) ?? 'unknown', license, observedAt };
  return { state: 'error', message: `unknown Junie quota state ${JSON.stringify(output.state)}` };
};

const REASONS: Record<Lang, Record<string, string>> = {
  pt: {
    inactive: 'A conta JetBrains não está ativa.',
    'unsupported-license': 'Esta licença não informa saldo.',
    'unsupported-unit': 'A JetBrains informou o saldo numa unidade desconhecida.',
    'missing-balance': 'A JetBrains não informou o saldo.',
    'invalid-response': 'A JetBrains respondeu num formato inesperado.',
    'invalid-context': 'O plugin do Junie não tem uma conexão ativa.',
    'invalid-credentials': 'O login do Junie é inválido. Entre de novo pelo OpenCode.',
    unauthorized: 'O login do Junie expirou. Entre de novo pelo OpenCode.',
    'rate-limited': 'A JetBrains limitou as consultas. Tente mais tarde.',
    'http-error': 'A JetBrains respondeu com erro.',
    'network-error': 'Sem conexão com a JetBrains.',
    'body-too-large': 'A resposta da JetBrains veio grande demais.',
    timeout: 'A JetBrains demorou demais para responder.',
    cancelled: 'A consulta foi cancelada.',
  },
  en: {
    inactive: 'The JetBrains account is not active.',
    'unsupported-license': 'This license reports no balance.',
    'unsupported-unit': 'JetBrains reported the balance in an unknown unit.',
    'missing-balance': 'JetBrains reported no balance.',
    'invalid-response': 'JetBrains answered in an unexpected format.',
    'invalid-context': 'The Junie plugin has no active connection.',
    'invalid-credentials': 'The Junie login is invalid. Sign in again through OpenCode.',
    unauthorized: 'The Junie login expired. Sign in again through OpenCode.',
    'rate-limited': 'JetBrains is rate limiting balance reads. Try again later.',
    'http-error': 'JetBrains answered with an error.',
    'network-error': 'Could not reach JetBrains.',
    'body-too-large': 'JetBrains sent too large an answer.',
    timeout: 'JetBrains took too long to answer.',
    cancelled: 'The read was cancelled.',
  },
};

const TEXT = {
  pt: {
    balance: 'Saldo',
    credits: 'créditos',
    license: (license: string) => `Licença ${license}`,
    hint: 'A JetBrains informa só o saldo restante, sem o total do plano nem a data de renovação.',
    noOpencode: 'Não encontrei o opencode no PATH do OpenChamber.',
    error: (message: string) => `Não consegui ler o saldo: ${message}`,
    unknown: (reason: string) => `Saldo indisponível (${reason}).`,
    refresh: 'Atualizar',
    readAt: (at: string) => `Lido em ${at}`,
  },
  en: {
    balance: 'Balance',
    credits: 'credits',
    license: (license: string) => `License ${license}`,
    hint: 'JetBrains reports only the balance left, not the plan total or a renewal date.',
    noOpencode: 'opencode was not found on OpenChamber\'s PATH.',
    error: (message: string) => `Could not read the balance: ${message}`,
    unknown: (reason: string) => `Balance unavailable (${reason}).`,
    refresh: 'Refresh',
    readAt: (at: string) => `Read at ${at}`,
  },
} as const;

const formatAmount = (amount: number, unit: 'credits' | 'USD', locale: string, lang: Lang): string => {
  try {
    if (unit === 'USD') return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(amount);
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(amount)} ${TEXT[lang].credits}`;
  } catch {
    return `${amount.toFixed(2)} ${unit === 'USD' ? 'USD' : TEXT[lang].credits}`;
  }
};

export const renderJunieBalance = (balance: JunieBalance | ReadFailure, lang: Lang, locale: string): GuestStatusView => {
  const t = TEXT[lang];
  const controls: GuestStatusView['controls'] = [{ kind: 'button', id: 'refresh', label: t.refresh }];
  const note = (id: string, text: string, tone: 'muted' | 'info' | 'warning' | 'error'): GuestStatusView => ({ rows: [{ kind: 'note', id, text: text.slice(0, 300), tone }], controls });
  switch (balance.state) {
    case 'no-opencode':
      return note('no-opencode', t.noOpencode, 'error');
    case 'error':
      return note('error', t.error(balance.message), 'error');
    case 'unavailable':
      return note('unavailable', REASONS[lang][balance.reason] ?? t.unknown(balance.reason), 'warning');
  }
  return {
    rows: [
      {
        kind: 'line',
        id: 'balance',
        label: t.balance,
        icon: 'coins',
        value: formatAmount(balance.amount, balance.unit, locale, lang),
        valueTone: balance.amount <= 0 ? 'error' : 'default',
        badge: balance.license ? { label: t.license(balance.license).slice(0, 60), tone: 'muted' } : undefined,
        tooltip: t.hint,
      },
      { kind: 'note', id: 'read-at', text: t.readAt(formatDateTime(balance.observedAt, locale)), tone: 'muted' },
    ],
    controls,
  };
};
