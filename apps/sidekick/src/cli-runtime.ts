export interface CliOutput {
  stdout(value: string): void;
  stderr(value: string): void;
  setExitCode(code: number): void;
}

export interface CliInvocation {
  command: string;
  arguments: readonly string[];
  env: NodeJS.ProcessEnv;
  output: CliOutput;
}

export interface CliDispatchOptions {
  env?: NodeJS.ProcessEnv;
  output?: CliOutput;
}

export interface ClosableStore {
  close(): void;
}

export interface OpenedStore<Store extends ClosableStore> {
  store: Store;
  backupPath: string | null;
}

export async function withStore<Store extends ClosableStore, Result>(
  openStore: () => Promise<OpenedStore<Store>>,
  action: (opened: OpenedStore<Store>) => Result | Promise<Result>,
): Promise<Result> {
  const opened = await openStore();
  try {
    return await action(opened);
  } finally {
    opened.store.close();
  }
}

export interface ConnectedContextDependencies<
  Config,
  Node,
  Api,
  Verification,
  Snapshot extends object,
> {
  loadConfig(): Config;
  clientsFromConfig(config: Config): { node: Node; api: Api };
  verificationContext(config: Config): Promise<Verification>;
  readOperatorAnchorSnapshot(options: {
    config: Config;
    node: Node;
    api: Api;
    managerPrincipal: string;
    managerVerification: Verification;
  }): Promise<Snapshot>;
}

export async function withConnectedContext<
  Config,
  Node,
  Api,
  Verification,
  Snapshot extends object,
  Result,
>(
  managerPrincipal: string,
  dependencies: ConnectedContextDependencies<Config, Node, Api, Verification, Snapshot>,
  action: (
    context: { config: Config; node: Node; api: Api } & Snapshot,
  ) => Result | Promise<Result>,
): Promise<Result> {
  const config = dependencies.loadConfig();
  const { node, api } = dependencies.clientsFromConfig(config);
  const managerVerification = await dependencies.verificationContext(config);
  const snapshot = await dependencies.readOperatorAnchorSnapshot({
    config,
    node,
    api,
    managerPrincipal,
    managerVerification,
  });
  return action({ config, node, api, ...snapshot });
}

export function writeCliJson(output: CliOutput, value: unknown): void {
  output.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeCliText(output: CliOutput, value: string): void {
  output.stdout(`${value}\n`);
}

function processOutput(): CliOutput {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    setExitCode: (code) => {
      process.exitCode = code;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function dispatchCli(
  arguments_: readonly string[],
  execute: (invocation: CliInvocation) => void | Promise<void>,
  options: CliDispatchOptions = {},
): Promise<{ exitCode: number }> {
  const [command = "help", ...commandArguments] = arguments_;
  const destination = options.output ?? processOutput();
  let exitCode = 0;
  const output: CliOutput = {
    stdout: (value) => destination.stdout(value),
    stderr: (value) => destination.stderr(value),
    setExitCode: (code) => {
      exitCode = code;
      destination.setExitCode(code);
    },
  };
  try {
    await execute({
      command,
      arguments: commandArguments,
      env: options.env ?? process.env,
      output,
    });
  } catch (error) {
    output.stderr(`${errorMessage(error)}\n`);
    output.setExitCode(1);
  }
  return { exitCode };
}
