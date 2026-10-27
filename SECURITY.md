# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| Older   | No        |

Only the latest 0.1.x release gets security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, pull request or discussion for a security problem.

Use GitHub's private vulnerability reporting:

1. Open the [Security tab](https://github.com/pratikgh0se/youtube-mcp/security) of this repository.
2. Choose **Report a vulnerability**.
3. Describe what you found, the version you tested, and the steps to reproduce it.

Never include real OAuth tokens, client secrets, API keys or personal data in a report. A description and a minimal reproduction are enough.

## What to expect

This project is maintained by one person, on a best-effort basis. There is no promised response or fix time. I will read every report, tell you whether I can reproduce it, and credit you in the fix if you want that.

## Scope

In scope:

- **OAuth token handling.** How the refresh token and OAuth client details are stored, read, refreshed and kept out of logs and tool output.
- **The approve-before-execute flow.** Anything that lets a write action run without an approval bound to the exact previewed change, reuse or forge an approval, or skip the preflight, approve, execute steps.
- **Local transports.** The stdio transport, and the optional HTTP transport that is meant to bind to `127.0.0.1` only.
- **Local data.** The approvals, upload recovery state and Takeout-derived database kept under `~/.youtube-mcp` (or `YOUTUBE_MCP_STATE_DIR`).

Out of scope:

- Vulnerabilities in Google's APIs or in YouTube itself. Report those to Google.
- Vulnerabilities in third-party dependencies with no effect on this project. Report those upstream.
- Problems that need an attacker who already has full access to your user account or your machine.
- An AI client approving a change that you chose to approve.
