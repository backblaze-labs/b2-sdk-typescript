# Retry upload POST connection failures

Goal: make `Bucket.upload()` recover from a connection reset or socket timeout during `b2_upload_file` by default, using a fresh upload URL. Closes #343.

Why now: the upload retry classifier currently requires `retryResponseBodyFailures: true` for a single-file `NetworkError` after the POST starts, contrary to B2's integration checklist. An unreadable success response body remains ambiguous and must stay opt-in.

- [x] Verify the retry classifier, fresh-URL path, existing tests, and B2 guidance.
- [x] Add failing default-behavior regressions for reset before response, reset mid-request, and socket stall.
- [x] Retry single-file connection failures while retaining the multipart, response-body, SSRF, and rate-limit gates.
- [x] Verify the diff: upload suite 241/241, `pnpm verify` green, slow multipart suite 33/33, coverage thresholds met, and all three repository-owned resilience scenarios passed against fresh local simulators.
- [ ] Open the issue-linked PR and request human and Copilot review.
