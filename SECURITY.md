# Security Policy

## Supported versions

| Version | Status |
|---|---|
| v0.2.x (latest stable) | Supported — security fixes apply here |
| v0.3.0-dev (`main`) | Development — fixes land on `main` |
| v0.1.x | Unsupported — upgrade |

## Reporting a vulnerability

Please **do not open a public issue** for exploitable vulnerabilities.

Report privately through **GitHub's private vulnerability reporting**:
[github.com/3bud-ZC/RootRay/security/advisories/new](https://github.com/3bud-ZC/RootRay/security/advisories/new)

Include: affected version, reproduction steps, impact, and any suggested
mitigation. We will acknowledge the report and coordinate a fix and
disclosure timeline with you. Do not publicly disclose details before a
fix is available.

## Security model

RootRay is **local-first** by design — understanding the boundaries
helps target reports usefully:

- **No remote attack surface by default.** The only listener is the
  inspector bridge on `ws://127.0.0.1` (loopback only) with an ephemeral
  per-session token on a dynamic port. Wrong token/session/version and
  malformed messages are rejected.
- **Preview isolation.** The embedded project Preview is a separate
  WebView2 with zero IPC privileges — every privileged Tauri command is
  denied to it natively. Main-frame navigation is loopback-only;
  `window.open`/`target=_blank` is denied; remote URLs open in the
  system browser unprivileged.
- **Filesystem boundary.** All file access is relative to the selected
  workspace root: `..` traversal, absolute paths, symlink escapes,
  `.env*`, keys/credentials, `.git`, `node_modules`, `target`, `dist`,
  binary and oversized files are refused.
- **Safe writes.** Saves use SHA-256 optimistic concurrency and
  same-directory atomic rename; external modifications surface as
  conflicts rather than silent clobbering.
- **Process containment.** Dev servers run inside a Windows Job Object
  with `KILL_ON_JOB_CLOSE`; unrelated processes are never touched and
  nothing is killed by port.
- **Narrow command surface.** The UI can only invoke an audited set of
  Tauri commands — there is no generic command API.
- **Discovery is inert.** Workspace analysis never executes project
  code, never reads secrets, and is bounded (depth/count/size caps).

## Out of scope

- Vulnerabilities in the user's own dev server or application — RootRay
  runs your project but doesn't proxy it.
- Issues requiring an already-compromised local account (the security
  boundary assumes the Windows user account is trusted).
