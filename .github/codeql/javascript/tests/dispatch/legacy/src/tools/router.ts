// Extraction-only fixtures: imported handlers/clients are harmless, inert stubs.
import { assertToolAllowed, assertResourceAllowed, assertToolAllowed as authorize } from './authorization.js';
import { toolRegistry } from './registry.js';
import { handleGetActors, handleReadResource, handleGetRecentLogs } from './handlers/stubs.js';

namespace goodDirect {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace goodAliases {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    const identifier = name; const client = foundryClient; authorize(identifier, client); switch (identifier) { case "stub": return handleGetActors(args, client); }
  }
}

namespace goodRegistry {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); const context = { foundryClient }; try { return await toolRegistry.execute(name, args, context); } catch (error) { throw error; }
  }
}

namespace goodRethrow {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    try { assertToolAllowed(name, foundryClient); } catch (error) { throw error; } switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace goodDiagnostics {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); switch (name) { case "stub": return handleGetRecentLogs(args, diagnosticsClient); }
  }
}

namespace missing {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace wrongIdentifier {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(otherName, foundryClient); switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace wrongClient {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, otherClient); switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace oneBranch {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    if (flag) assertToolAllowed(name, foundryClient); switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace late {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); } assertToolAllowed(name, foundryClient);
  }
}

namespace swallowed {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    try { assertToolAllowed(name, foundryClient); } catch {} switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace wrongGuard {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertResourceAllowed(name, foundryClient); switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace changedName {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); name = otherName; switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace changedClient {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); foundryClient = otherClient; switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace changedBoth {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(otherName, otherClient); switch (otherName) { case "stub": return handleGetActors(args, otherClient); }
  }
}

namespace wrongContext {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); const context = { foundryClient: otherClient }; return toolRegistry.execute(name, args, context);
  }
}

namespace mutatedContext {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); const context = { foundryClient }; context.foundryClient = otherClient; return toolRegistry.execute(name, args, context);
  }
}

namespace spreadContext {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); const context = { foundryClient, ...args }; return toolRegistry.execute(name, args, context);
  }
}

namespace shadowedGuard {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    const assertToolAllowed = (_name: unknown, _client: unknown) => {}; assertToolAllowed(name, foundryClient); switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace guardInCallback {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    [name].forEach(() => assertToolAllowed(name, foundryClient)); switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace goodResource {
  export function routeResourceRequest(uri: string, foundryClient: any, diagnosticsClient: any, otherClient: any, otherUri: string, flag: boolean) {
    assertResourceAllowed(uri, foundryClient); return handleReadResource(uri, foundryClient, diagnosticsClient);
  }
}

namespace missingResource {
  export function routeResourceRequest(uri: string, foundryClient: any, diagnosticsClient: any, otherClient: any, otherUri: string, flag: boolean) {
    return handleReadResource(uri, foundryClient, diagnosticsClient);
  }
}

namespace wrongResourceIdentifier {
  export function routeResourceRequest(uri: string, foundryClient: any, diagnosticsClient: any, otherClient: any, otherUri: string, flag: boolean) {
    assertResourceAllowed(otherUri, foundryClient); return handleReadResource(uri, foundryClient, diagnosticsClient);
  }
}

namespace wrongResourceClient {
  export function routeResourceRequest(uri: string, foundryClient: any, diagnosticsClient: any, otherClient: any, otherUri: string, flag: boolean) {
    assertResourceAllowed(uri, otherClient); return handleReadResource(uri, foundryClient, diagnosticsClient);
  }
}

namespace resourceOneBranch {
  export function routeResourceRequest(uri: string, foundryClient: any, diagnosticsClient: any, otherClient: any, otherUri: string, flag: boolean) {
    if (flag) assertResourceAllowed(uri, foundryClient); return handleReadResource(uri, foundryClient, diagnosticsClient);
  }
}

namespace resourceSwallowed {
  export function routeResourceRequest(uri: string, foundryClient: any, diagnosticsClient: any, otherClient: any, otherUri: string, flag: boolean) {
    try { assertResourceAllowed(uri, foundryClient); } catch {} return handleReadResource(uri, foundryClient, diagnosticsClient);
  }
}
