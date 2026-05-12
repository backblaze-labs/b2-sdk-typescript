# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.x (pre-release) | Yes |

Once 1.0 ships, only the latest minor release will receive security patches.

## Reporting a vulnerability

**Do not open a public issue for security vulnerabilities.**

Email security@backblaze.com with:

- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if you have one)

You will receive acknowledgment within 48 hours. We aim to provide a fix or mitigation within 7 days for critical issues.

## Scope

This SDK handles Backblaze B2 application keys and authorization tokens. Security-relevant areas include:

- **Credential handling**: Application keys are passed to `B2Client` and transmitted via HTTPS Basic auth or `Authorization` headers. The SDK never logs, serializes to disk, or exposes credentials beyond the `AccountInfo` backend.
- **SSE-C keys**: Customer-provided encryption keys are set in HTTP headers and never persisted. The SDK does not log these values.
- **Authorization tokens**: Stored in the `AccountInfo` backend (in-memory by default). Tokens are scoped and time-limited by the B2 API.
- **Transport security**: The SDK uses HTTPS for all B2 API communication. It does not disable certificate verification.
- **Input validation**: File names are percent-encoded per B2 requirements before transmission. User-supplied metadata is passed through to headers with B2-specific encoding.

## Best practices for users

- Never embed `applicationKey` in client-side (browser) code. Use short-lived `b2_get_upload_url` or `b2_get_download_authorization` tokens from a backend.
- Use application keys scoped to specific buckets and capabilities when possible.
- Rotate application keys regularly.
- Enable object lock (file retention) for compliance-sensitive data.
- Use SSE-B2 or SSE-C for encryption at rest.
