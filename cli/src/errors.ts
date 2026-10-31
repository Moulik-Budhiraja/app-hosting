export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 3,
  network: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string;

  constructor(message: string, exitCode: ExitCode = EXIT.failure, code = "FAILED") {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

export function usage(message: string): CliError {
  return new CliError(message, EXIT.usage, "USAGE");
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
      || code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL") {
      return new CliError(error.message, EXIT.usage, "USAGE");
    }
    return new CliError(error.message, EXIT.failure, "FAILED");
  }
  return new CliError(String(error));
}
