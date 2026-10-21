# MCP Protocol Contract

The MCP layer is the part of Muca most likely to break silently. This file
records the exact contract and the traps found while building it.

## Pinned versions

| Package | Version | Note |
|---|---|---|
| `@modelcontextprotocol/sdk` | `1.32.1` | Pinned **exactly**, not `^` |
| `zod` | `4.6.7` | Unified via the root `overrides` entry |

### The zod trap (important)

`@modelcontextprotocol/sdk` depends on `zod-to-json-schema`, which has a
peer dependency of `zod: ^3.25.28 || ^4`. Without an override, npm installs
**both** zod 3.25.76 (for the SDK) and zod 4.6.7 (for `apps/server`).

The failure is not a type error — it is a **runtime** error:

```
Error: Cannot find package 'zod-to-json-schema' imported from
  node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-json-schema-compat.js
```

The root `package.json` therefore contains:

```json
"overrides": { "zod": "4.6.7" }
```

**If the zod version is ever changed, re-verify this.** The SDK's
`zod-compat` layer detects Zod v4 by checking `schema._zod`, and converts
with `zod/v4-mini`. Zod v4 must keep exposing the `v4-mini` subpath.

## Protocol version

`2025-11-25` is `LATEST_PROTOCOL_VERSION` in SDK `1.32.1`:

```js
// node_modules/@modelcontextprotocol/sdk/dist/esm/types.js
export const LATEST_PROTOCOL_VERSION = '2025-11-25';
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07',
];
```

The server does **not** hardcode a version check of its own — the SDK
negotiates it. `MCP_PROTOCOL_VERSION` in `.env` is only what the UI
displays.

## Transport

- **Streamable HTTP**, mounted at `/api/v1/mcp`.
- **Stateful.** `POST` with an `initialize` request creates a session and
  returns an `Mcp-Session-Id` header. Every later request must carry it.
- `GET` opens the server→client SSE stream. `DELETE` closes the session.
- A `POST` without a session id that is not an `initialize` request gets
  `400`. A `POST` with an unknown session id gets `404`.

## Session lifecycle

```
POST /api/v1/mcp   {jsonrpc, id, method: "initialize", params: {...}}
        │
        ├─► 200, header `Mcp-Session-Id: <uuid>`
        │
POST /api/v1/mcp   header `Mcp-Session-Id: <uuid>`  {method: "tools/list"}
        │
        ├─► 200, SSE or JSON body with the tool list
        │
POST /api/v1/mcp   header `Mcp-Session-Id: <uuid>`  {method: "tools/call", ...}
        │
        └─► 200, the tool result
```

## The request body must be parsed

`McpHttpHandler` expects `req.body` to already be parsed. In the Express
app this is done by `express.json()` mounted on `/api/v1`. The handler uses
the **raw Node response API** (`res.writeHead` / `res.end`) rather than
`res.status().json()`, so the same handler works behind a bare
`http.createServer` — which is what the tests use.

This is deliberate: the test suite exercises the real transport without
needing Express.

## Tool annotations

Destructive tools are published with:

```ts
{
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
  title: tool.title,
}
```

This is what a client sees in `tools/list`, and it is the signal an MCP
client would use to prompt its user.

## JSON Schema conversion

The SDK converts the Zod schema to JSON Schema itself. `apps/server` does
**not** need `zod-to-json-schema` — it uses Zod v4's built-in
`z.toJSONSchema(schema, { io: 'input' })` for the provider catalogue, and
the SDK publishes its own version over MCP.

Note the difference: the SDK publishes `type: "integer"` for numbers, while
`z.toJSONSchema` publishes `type: "number"`. Both are valid JSON Schema.

## How to verify a change

```bash
# unit + integration suite (real SDK client, real HTTP server)
npm test --workspace @muca/server

# live probe against a running server
node -e "
import('@modelcontextprotocol/sdk/client/index.js').then(async ({Client}) => {
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const c = new Client({name:'probe',version:'0.1.0'},{capabilities:{}});
  await c.connect(new StreamableHTTPClientTransport(new URL('http://localhost:8099/api/v1/mcp')));
  console.log(c.getServerVersion());
  console.log((await c.listTools()).tools.map(t => t.name));
  await c.close();
});
"
```

## Checklist when changing the SDK version

- [ ] `LATEST_PROTOCOL_VERSION` in the new SDK — is `2025-11-25` still
      supported?
- [ ] Does the new SDK still accept Zod v4 schemas? (`isZ4Schema` check)
- [ ] Does `zod/v4-mini` still exist in the installed zod?
- [ ] Re-run `npm test --workspace @muca/server`.
- [ ] Re-run the live probe above and compare the tool list.
