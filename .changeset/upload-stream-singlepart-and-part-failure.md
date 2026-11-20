---
"@backblaze-labs/b2-sdk": patch
---

Use single-request uploads for streams that fit in one part. Reject completion and cancel the unfinished large file when an upload part fails, even if the writer remains open.
