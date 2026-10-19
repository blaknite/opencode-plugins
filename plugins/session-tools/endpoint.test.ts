import { test, expect } from "bun:test";
import { currentServerEndpoint } from "./endpoint.ts";

test("finds an authenticated OpenChamber-managed server", () => {
  expect(
    currentServerEndpoint(
      ["opencode", "serve", "--hostname", "127.0.0.1", "--port", "49156"],
      { OPENCODE_SERVER_PASSWORD: "test-password" },
    ),
  ).toEqual({
    url: "http://127.0.0.1:49156",
    auth: { type: "basic", username: "opencode", password: "test-password" },
  });
});

test("supports equals-style options and custom usernames", () => {
  expect(
    currentServerEndpoint(
      ["opencode", "serve", "--hostname=localhost", "--port=4096"],
      { OPENCODE_SERVER_USERNAME: "custom", OPENCODE_SERVER_PASSWORD: "secret" },
    ),
  ).toEqual({
    url: "http://localhost:4096",
    auth: { type: "basic", username: "custom", password: "secret" },
  });
});

test("connects through loopback for wildcard listeners", () => {
  for (const [hostname, host] of [["0.0.0.0", "127.0.0.1"], ["::", "[::1]"], ["::1", "[::1]"]]) {
    expect(
      currentServerEndpoint(
        ["opencode", "serve", "--hostname", hostname!, "--port", "4096"],
        {},
      ),
    ).toEqual({ url: `http://${host}:4096`, auth: undefined });
  }
});

test("leaves service discovery to handle servers without an explicit endpoint", () => {
  for (const args of [
    [],
    ["--standalone"],
    ["serve", "--service"],
    ["serve", "--port", "4096"],
    ["serve", "--hostname", "127.0.0.1", "--port", "0"],
    ["serve", "--hostname", "127.0.0.1", "--port", "65536"],
    ["serve", "--hostname", "127.0.0.1", "--port", "invalid"],
  ]) {
    expect(currentServerEndpoint(["opencode", ...args], {})).toBeUndefined();
  }
});
