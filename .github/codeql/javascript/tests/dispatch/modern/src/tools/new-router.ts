// Extraction-only fixtures: imported handlers/clients are harmless, inert stubs.
import { assertToolAllowed, assertResourceAllowed, assertToolAllowed as authorize } from './authorization.js';
import { toolRegistry } from './registry.js';
import { handleGetActors, handleReadResource, handleGetRecentLogs } from './handlers/stubs.js';

namespace goodHelper {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); return await routeLegacyTool(name, args, foundryClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace goodHelperDiagnostics {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); return routeLegacyTool(name, args, foundryClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetRecentLogs(args, undefined); }
  }
}

namespace goodRegistryAndHelper {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); const context = { foundryClient }; if (flag) return toolRegistry.execute(name, args, context); return routeLegacyTool(name, args, foundryClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace missingHelper {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    return routeLegacyTool(name, args, foundryClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace wrongHelperClient {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); return routeLegacyTool(name, args, otherClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace wrongHelperIdentifier {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(otherName, foundryClient); return routeLegacyTool(name, args, foundryClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace helperChangedClient {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); return routeLegacyTool(name, args, foundryClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    foundryClient = {}; switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace helperChangedName {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); return routeLegacyTool(name, args, foundryClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    name = "other"; switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace helperOtherCaller {
  export async function routeToolRequest(name: string, args: any, foundryClient: any, diagnosticsClient: any, otherClient: any, otherName: string, flag: boolean) {
    assertToolAllowed(name, foundryClient); if (flag) return routeLegacyTool(name, args, foundryClient); return routeLegacyTool(name, args, otherClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace newGoodResource {
  export function routeResourceRequest(uri: string, foundryClient: any, diagnosticsClient: any) {
    assertResourceAllowed(uri, foundryClient);
    return handleReadResource(uri, foundryClient, diagnosticsClient);
  }
}
namespace newMissingResource {
  export function routeResourceRequest(uri: string, foundryClient: any, diagnosticsClient: any) {
    return handleReadResource(uri, foundryClient, diagnosticsClient);
  }
}

namespace exportedHelper {
  export async function routeToolRequest(name: string, args: any, foundryClient: any) {
    assertToolAllowed(name, foundryClient); return routeLegacyTool(name, args, foundryClient);
  }
  export async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
}

namespace escapedHelper {
  export async function routeToolRequest(name: string, args: any, foundryClient: any) {
    assertToolAllowed(name, foundryClient); return routeLegacyTool(name, args, foundryClient);
  }
  async function routeLegacyTool(name: string, args: any, foundryClient: any) {
    switch (name) { case "stub": return handleGetActors(args, foundryClient); }
  }
  export const escaped = routeLegacyTool;
}
