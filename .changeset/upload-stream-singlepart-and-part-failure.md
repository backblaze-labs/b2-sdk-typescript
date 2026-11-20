---
"@backblaze-labs/b2-sdk": patch
---

Finalize streams that fit in one part through the single-request upload path, forwarding only supported streaming options. At exactly one part, cancel the provisional large file and upload the retained bytes again as a single file. Reject completion and cancel the unfinished large file when an upload part fails, even if the writer remains open.
