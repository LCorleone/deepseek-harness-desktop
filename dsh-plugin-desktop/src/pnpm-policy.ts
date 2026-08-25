/** Desktop-wide pnpm policy applied to every package-manager operation. */

/**
 * DSH Desktop accepts explicitly requested package versions immediately.
 * Keep this process-local: never rewrite a user's pnpm configuration file.
 */
export const PNPM_IGNORE_MINIMUM_RELEASE_AGE = '--config.minimumReleaseAge=0'

/** Prefix a pnpm argv without adding the same Desktop policy twice. */
export function withDesktopPnpmPolicy(argv: readonly string[]): string[] {
  if (argv.includes(PNPM_IGNORE_MINIMUM_RELEASE_AGE)) return [...argv]
  return [PNPM_IGNORE_MINIMUM_RELEASE_AGE, ...argv]
}

/** Apply the pnpm policy only to the arguments forwarded by `dsh plugin`. */
export function withDesktopDshPluginPolicy(argv: readonly string[]): string[] {
  if (argv[0] !== 'plugin' || argv.includes(PNPM_IGNORE_MINIMUM_RELEASE_AGE)) return [...argv]
  let forwardedArgumentsStart = 1
  if (argv[1] === '--profile' && argv[2] !== undefined) forwardedArgumentsStart = 3
  else if (argv[1]?.startsWith('--profile=') === true) forwardedArgumentsStart = 2
  return [
    ...argv.slice(0, forwardedArgumentsStart),
    PNPM_IGNORE_MINIMUM_RELEASE_AGE,
    ...argv.slice(forwardedArgumentsStart),
  ]
}
