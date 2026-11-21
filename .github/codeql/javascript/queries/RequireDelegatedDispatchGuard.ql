/**
 * @name Delegated dispatch without matching authorization
 * @description A public MCP dispatch must be preceded on every path by successful
 *              authorization for the dispatched identifier and Foundry client.
 * @kind problem
 * @problem.severity error
 * @security-severity 8.1
 * @precision high
 * @id foundryvtt-mcp/require-delegated-dispatch-guard
 * @tags security
 *       external/cwe/cwe-862
 */

import javascript

/** This is a repository policy, scoped to the two public router implementations. */
private predicate router(Function f) {
  f.getFile().getRelativePath().matches("%src/tools/router.ts") or
  f.getFile().getRelativePath().matches("%src/tools/new-router.ts")
}

/** Follow SSA refinements and simple aliases, but never merge different SSA values. */
private SsaVariable valueOrigin(SsaVariable v) {
  result = valueOrigin(v.(SsaRefinementNode).getAnInput())
  or
  result = valueOrigin(v.(SsaExplicitDefinition).getDef().getSource().(Expr)
      .getUnderlyingValue().(VarUse).getSsaVariable())
  or
  not v instanceof SsaRefinementNode and
  not exists(v.(SsaExplicitDefinition).getDef().getSource().(Expr)
      .getUnderlyingValue().(VarUse).getSsaVariable()) and
  result = v
}

private predicate sameValue(Expr a, Expr b) {
  valueOrigin(a.getUnderlyingValue().(VarUse).getSsaVariable()) =
    valueOrigin(b.getUnderlyingValue().(VarUse).getSsaVariable())
  or
  exists(Function f, int index |
    a = f.getParameter(index) and parameterValue(b, f, index)
    or
    b = f.getParameter(index) and parameterValue(a, f, index)
  )
}

private predicate parameterValue(Expr e, Function f, int index) {
  e = f.getParameter(index)
  or
  valueOrigin(e.getUnderlyingValue().(VarUse).getSsaVariable()).getSourceVariable() =
    f.getParameter(index).getAVariable() and
  valueOrigin(e.getUnderlyingValue().(VarUse).getSsaVariable()).getDefinition()
    .getAContributingVarDef().getTarget() = f.getParameter(index)
}

/** Resolve the actual import binding, including renamed imports; names alone are insufficient. */
private predicate importedCall(CallExpr call, string modulePath, string member) {
  exists(ImportSpecifier spec |
    call.getCallee().getUnderlyingValue().(VarRef).getVariable() = spec.getLocal().getVariable() and
    spec.getImportedName() = member and
    spec.getImportDeclaration().getImportedPathExpr().(StringLiteral).getValue() = modulePath
  )
}

private predicate authorization(CallExpr guard, string kind) {
  importedCall(guard, "./authorization.js", "assert" + kind + "Allowed")
}

/** Reachability after removing the assertion call proves it is present on every path. */
private predicate reachesWithout(
  ControlFlowNode start, ControlFlowNode target, ControlFlowNode excluded
) {
  // Keep the recursive relation inside an actual router dispatch's CFG.
  // Without this bound, unrelated repository CFGs multiply the reachability work.
  dispatch(target.(CallExpr), _) and authorization(excluded.(CallExpr), _) and
  excluded.getContainer() = target.getContainer() and
  start.getContainer() = target.getContainer() and
  (
    start = target
    or
    start != excluded and
    reachesWithout(start.getASuccessor(), target, excluded)
  )
}

private predicate successfulBefore(CallExpr guard, CallExpr dispatch) {
  guard.getEnclosingFunction() = dispatch.getEnclosingFunction() and
  not reachesWithout(dispatch.getEnclosingFunction().getStart(), dispatch, guard) and
  // Dominance of the call alone also admits caught authorization exceptions.
  // Reject any catch/finally continuation that can still reach dispatch.
  not exists(TryStmt t |
    guard.getParent*() = t.getBody() and
    (
      t.getACatchClause().getFirstControlFlowNode().getASuccessor*() = dispatch or
      t.getFinally().getFirstControlFlowNode().getASuccessor*() = dispatch
    )
  )
}

private predicate guarded(CallExpr dispatch, string kind, Expr identifier, Expr client) {
  exists(CallExpr guard |
    authorization(guard, kind) and
    sameValue(guard.getArgument(0), identifier) and
    sameValue(guard.getArgument(1), client) and
    successfulBefore(guard, dispatch)
  )
}

/** Registry contexts are the local, unmodified object literal passed to execute. */
private ObjectExpr contextObject(Expr context) {
  result = context.getUnderlyingValue().(ObjectExpr)
  or
  result = context.getUnderlyingValue().(VarUse).getSsaVariable()
    .(SsaExplicitDefinition).getDef().getSource().(ObjectExpr)
}

private Expr registryClient(CallExpr dispatch) {
  exists(Expr context, ObjectExpr obj |
    context = dispatch.getArgument(2) and obj = contextObject(context) and
    count(obj.getPropertyByName("foundryClient")) = 1 and
    not exists(Property p | p = obj.getAProperty() | not exists(p.getName())) and
    not exists(PropAccess write |
      write = any(Assignment assignment).getLhs() and sameValue(write.getBase(), context)
    ) and
    result = obj.getPropertyByName("foundryClient").getInit()
  )
}

private predicate registryDispatch(CallExpr call) {
  exists(PropAccess callee |
    callee = call.getCallee().getUnderlyingValue() and
    callee.getPropertyName() = "execute" and
    exists(ImportSpecifier spec |
      callee.getBase().(VarRef).getVariable() = spec.getLocal().getVariable() and
      spec.getImportedName() = "toolRegistry" and
      spec.getImportDeclaration().getImportedPathExpr().(StringLiteral).getValue() = "./registry.js"
    )
  )
}

private predicate legacyCall(CallExpr call, Function helper) {
  helper.getName() = "routeLegacyTool" and router(helper) and
  call.getCallee().getUnderlyingValue().(VarRef).getVariable() = helper.getVariable()
}

private predicate handlerDispatch(CallExpr call, string handler) {
  exists(ImportSpecifier spec |
    call.getCallee().getUnderlyingValue().(VarRef).getVariable() = spec.getLocal().getVariable() and
    spec.getImportedName() = handler and handler.matches("handle%") and
    spec.getImportDeclaration().getImportedPathExpr().(StringLiteral).getValue().matches("./handlers/%")
  )
}

/** The switch discriminant selects a legacy handler, rather than its payload argument. */
private Expr selectedTool(CallExpr dispatch) {
  exists(SwitchStmt selection |
    dispatch.getParent+() = selection and
    result = selection.getExpr()
  )
}

private Expr handlerClient(CallExpr dispatch, string handler) {
  handlerDispatch(dispatch, handler) and
  (
  // These handlers use diagnosticsClient or no client; authorization still binds
  // the route's Foundry client that determines whether the session is delegated.
  handler = ["handleGenerateNPC", "handleGenerateLoot", "handleDiagnoseErrors",
    "handleGetRecentLogs", "handleSearchLogs", "handleGetSystemHealth"] and
  result = dispatch.getEnclosingFunction().getParameter(2)
  or
  not handler = ["handleGenerateNPC", "handleGenerateLoot", "handleDiagnoseErrors",
    "handleGetRecentLogs", "handleSearchLogs", "handleGetSystemHealth"] and
  result = dispatch.getArgument(1)
  )
}

/** Boundary calls into the shared helper must themselves be authorized. */
private predicate dispatch(CallExpr call, string kind) {
  router(call.getEnclosingFunction()) and
  (
    call.getEnclosingFunction().getName() = "routeToolRequest" and
    (registryDispatch(call) or legacyCall(call, _) or handlerDispatch(call, _)) and kind = "Tool"
    or
    call.getEnclosingFunction().getName() = "routeResourceRequest" and
    handlerDispatch(call, "handleReadResource") and kind = "Resource"
    or
    call.getEnclosingFunction().getName() = "routeLegacyTool" and
    handlerDispatch(call, _) and kind = "Tool"
  )
}

/** Bind the dispatch to the original public route arguments, including aliases. */
private predicate requestedValues(CallExpr call, string kind, Expr identifier, Expr client) {
  parameterValue(identifier, call.getEnclosingFunction(), 0) and
  (
    kind = "Tool" and parameterValue(client, call.getEnclosingFunction(), 2)
    or
    kind = "Resource" and parameterValue(client, call.getEnclosingFunction(), 1)
  )
}

private predicate dispatchValues(CallExpr call, Expr identifier, Expr client) {
  registryDispatch(call) and identifier = call.getArgument(0) and client = registryClient(call)
  or
  legacyCall(call, _) and identifier = call.getArgument(0) and client = call.getArgument(2)
  or
  handlerDispatch(call, "handleReadResource") and
  identifier = call.getArgument(0) and client = call.getArgument(1)
  or
  exists(string handler |
    handlerDispatch(call, handler) and handler != "handleReadResource" and
    identifier = selectedTool(call) and client = handlerClient(call, handler)
  )
}

private predicate locallyAuthorized(CallExpr call, string kind) {
  exists(Expr identifier, Expr client |
    dispatchValues(call, identifier, client) and
    requestedValues(call, kind, identifier, client) and
    guarded(call, kind, identifier, client)
  )
}

private predicate inheritedAuthorization(CallExpr call) {
  exists(Function helper, string handler |
    helper = call.getEnclosingFunction() and helper.getName() = "routeLegacyTool" and
    handlerDispatch(call, handler) and
    parameterValue(selectedTool(call), helper, 0) and
    parameterValue(handlerClient(call, handler), helper, 2) and
    // Inheritance is valid only for a private helper with direct, visible callers.
    not exists(ExportDeclaration export | export.exportsDirectlyAs(helper.getVariable(), _)) and
    forall(VarRef reference | reference.getVariable() = helper.getVariable() and
      not reference instanceof VarDecl |
      exists(CallExpr entry | reference = entry.getCallee() and legacyCall(entry, helper))
    ) and
    exists(CallExpr entry | legacyCall(entry, helper)) and
    forall(CallExpr entry | legacyCall(entry, helper) |
      locallyAuthorized(entry, "Tool")
    )
  )
}

from CallExpr call, string kind
where
  dispatch(call, kind) and
  not locallyAuthorized(call, kind) and
  not inheritedAuthorization(call)
select call,
  kind + " dispatch requires a successful matching delegated authorization for its identifier and Foundry client on every path."
