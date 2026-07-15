/**
 * Retries a long remote-network sync (e.g. `npm run deploy -- --network preprod`)
 * across process crashes.
 *
 * A first-ever wallet sync against a long-lived chain can OOM partway through
 * even with a generous heap. Each attempt's wallet checkpoint (see
 * startCheckpointing in src/wallet.ts) preserves progress on a 30s throttle,
 * so a crashed attempt resumes closer to the chain tip on the next try instead
 * of replaying from genesis. This wrapper just keeps relaunching the given
 * command until one attempt exits 0, or the attempt cap is hit.
 *
 * Usage: npx tsx scripts/sync-retry.ts -- npm run deploy -- --network preprod
 */
import { spawnSync } from 'node:child_process';

const MAX_ATTEMPTS = Number(process.env.SYNC_RETRY_MAX_ATTEMPTS ?? 30);
const RETRY_DELAY_SECONDS = Number(process.env.SYNC_RETRY_DELAY_SECONDS ?? 5);
const HEAP_MB = Number(process.env.SYNC_RETRY_HEAP_MB ?? 9216);

function main(): number {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('Usage: sync-retry.ts <command> [args...]\n');
    return 1;
  }
  const [cmd, ...cmdArgs] = args;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    process.stdout.write(`\n=== sync-retry: attempt ${attempt}/${MAX_ATTEMPTS} ===\n\n`);
    const result = spawnSync(cmd, cmdArgs, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${HEAP_MB}` },
    });

    if (result.status === 0) {
      process.stdout.write(`\n=== sync-retry: succeeded on attempt ${attempt} ===\n\n`);
      return 0;
    }

    process.stdout.write(
      `\n=== sync-retry: attempt ${attempt} failed (exit ${result.status ?? 'signal ' + result.signal}); ` +
        `checkpoint saved, retrying in ${RETRY_DELAY_SECONDS}s ===\n\n`,
    );
    if (attempt < MAX_ATTEMPTS) {
      spawnSync('sleep', [String(RETRY_DELAY_SECONDS)]);
    }
  }

  process.stderr.write(`\n=== sync-retry: exhausted ${MAX_ATTEMPTS} attempts without success ===\n\n`);
  return 1;
}

process.exit(main());
