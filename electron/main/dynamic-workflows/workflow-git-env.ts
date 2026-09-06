
export const NON_INTERACTIVE_GIT_SSH_COMMAND =
  'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10';

export const NON_INTERACTIVE_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: NON_INTERACTIVE_GIT_SSH_COMMAND,
  GIT_ASKPASS: '/bin/false',
  SSH_ASKPASS: '/bin/false',
  SSH_ASKPASS_REQUIRE: 'never',
  GIT_OPTIONAL_LOCKS: '0',
});

export function nonInteractiveGitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, ...NON_INTERACTIVE_GIT_ENV };
}

export function applyNonInteractiveGitEnvToProcess(
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, value] of Object.entries(NON_INTERACTIVE_GIT_ENV)) {
    env[key] = value;
  }
}
