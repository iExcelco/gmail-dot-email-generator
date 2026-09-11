// Build stub for `@x402/fetch`.
//
// agentmail dynamically `import("@x402/fetch")` ONLY when its client is
// constructed with an `x402` payment option (see node_modules/agentmail/dist/
// esm/wrapper/Client.mjs and .../x402.mjs). GDV constructs the client as
// `new AgentMailClient({ apiKey })`, which takes the non-x402 branch, so this
// module is never actually imported at runtime.
//
// The real `@x402/fetch` package is not installed, and esbuild (wrangler's
// bundler) eagerly resolves the dynamic-import specifier at BUILD time, which
// fails. We alias `@x402/fetch` to this file in wrangler.jsonc so the build
// succeeds. It exports the named symbols agentmail destructures, each throwing
// if ever invoked — a clear signal if an x402 code path is ever reached.

function notSupported() {
  throw new Error(
    '@x402/fetch is not bundled in this Worker (x402 payments are unused by GDV).'
  );
}

export class x402HTTPClient {
  constructor() {
    notSupported();
  }
}

export function wrapFetchWithPayment() {
  notSupported();
}
