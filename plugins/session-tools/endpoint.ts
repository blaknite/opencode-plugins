import type { Endpoint } from "@opencode/client/service";

export function currentServerEndpoint(
  argv = process.argv,
  env = process.env,
): Endpoint | undefined {
  const command = argv.indexOf("serve", 1);
  if (command === -1) return;
  const args = argv.slice(command + 1);
  const option = (name: string) => {
    const index = args.findLastIndex(
      (arg) => arg === name || arg.startsWith(`${name}=`),
    );
    if (index === -1) return;
    const arg = args[index]!;
    return arg === name ? args[index + 1] : arg.slice(name.length + 1);
  };
  const hostname = option("--hostname");
  const port = option("--port");
  if (!hostname || !port || !/^\d+$/.test(port)) return;
  if (Number(port) < 1 || Number(port) > 65535) return;

  const host =
    hostname === "0.0.0.0" ? "127.0.0.1" : hostname === "::" ? "::1" : hostname;
  const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const url = new URL(`http://${address}:${port}`);
  const password = env.OPENCODE_SERVER_PASSWORD;
  return {
    url: url.origin,
    auth: password
      ? {
          type: "basic",
          username: env.OPENCODE_SERVER_USERNAME || "opencode",
          password,
        }
      : undefined,
  };
}
