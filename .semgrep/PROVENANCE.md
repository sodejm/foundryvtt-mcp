# Semgrep rule provenance

Unmodified community rules and their regression fixtures from [semgrep/semgrep-rules](https://github.com/semgrep/semgrep-rules/tree/9bbf021d0acffa3095fcffd17b2bc7787eb4796d), commit `9bbf021d0acffa3095fcffd17b2bc7787eb4796d`. See LICENSE and each rule metadata.

This subset covers JavaScript/TypeScript process execution, dynamic evaluation, object assignment, buffer safety, WebSockets, cryptography and JWT verification where available. It complements CodeQL, dependency auditing and manual authentication review; it is not an exhaustive security audit. Generated files and rule fixtures are outside the application scan. Tests and application scripts are not exempt.

Update rules deliberately, retain provenance, and run `semgrep --test --config .semgrep/rules .semgrep/tests` plus the application scan. Scanner version: 1.179.0.

## Source files

- `javascript/lang/security/detect-child-process.yaml`
- `javascript/lang/security/detect-eval-with-expression.yaml`
- `javascript/lang/security/detect-buffer-noassert.yaml`
- `javascript/lang/security/detect-pseudoRandomBytes.yaml`
- `javascript/lang/security/detect-insecure-websocket.yaml`
- `javascript/lang/security/insecure-object-assign.yaml`
- `javascript/lang/security/audit/spawn-shell-true.yaml`
- `javascript/node-crypto/security/gcm-no-tag-length.yaml`
- `javascript/node-crypto/security/aead-no-final.yaml`
- `javascript/node-crypto/security/create-de-cipher-no-iv.yaml`
- `javascript/jose/security/jwt-none-alg.yaml`
- `javascript/jsonwebtoken/security/jwt-none-alg.yaml`
- `javascript/jwt-simple/security/jwt-simple-noverify.yaml`
- `javascript/jsonwebtoken/security/audit/jwt-decode-without-verify.yaml`
