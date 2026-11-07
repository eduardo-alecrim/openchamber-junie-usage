import { cachedRead, CliError, langOf, runCli, serveStatusSection } from '../src/shared.ts';
import { JUNIE_QUOTA_ARGS, parseJunieBalance, renderJunieBalance, type JunieBalance, type ReadFailure } from '../src/usage.ts';

const TTL_MS = 2 * 60_000;
const TIMEOUT_MS = 30_000;

const readBalance = async (): Promise<JunieBalance | ReadFailure> => {
  try {
    const { stdout } = await runCli('opencode', JUNIE_QUOTA_ARGS, TIMEOUT_MS);
    return parseJunieBalance(stdout);
  } catch (error) {
    if (error instanceof CliError) {
      if (error.code === 'ENOENT') return { state: 'no-opencode' };
      const parsed = parseJunieBalance(error.stdout);
      if (parsed.state !== 'error') return parsed;
      const detail = error.stderr.trim().split('\n')[0];
      if (detail) return { state: 'error', message: detail.slice(0, 200) };
    }
    return { state: 'error', message: error instanceof Error ? error.message : String(error) };
  }
};

const read = cachedRead(TTL_MS, readBalance);

serveStatusSection({
  render: async (locale) => renderJunieBalance(await read(), langOf(locale), locale),
  act: async (event) => {
    if (event.id === 'refresh') await read(true);
  },
});
