# Retry upload POST connection failures

Goal: make `Bucket.upload()` recover from a connection reset or socket timeout during `b2_upload_file` and `b2_upload_part` by default, using a fresh upload URL. Closes #343 through PR #344.

Why now: the first PR version fixed single-file uploads, but the retry classifier still requires `retryResponseBodyFailures: true` for a part `NetworkError` after the POST starts. B2 recommends retrying part connection failures with a fresh part URL. Re-uploading the same part number replaces that part. An unreadable success response body remains ambiguous and must stay opt-in for both modes.

- [x] Verify the part path wraps response-body reads in `UploadResponseBodyError`, which becomes a retryable `NetworkError` only when opted in; the retry loop fetches a fresh part URL.
- [x] Add failing default-behavior part regressions for reset before response, reset mid-request, and socket stall.
- [x] Retry connection failures for single-file and part uploads while retaining the response-body, SSRF, rate-limit, and backoff gates.
- [x] Check an already-stored part can be re-uploaded under the same part number, and response-body reads retry only with opt-in.
- [x] Verify locally: upload suite 246/246 passed and `pnpm verify` completed successfully.
