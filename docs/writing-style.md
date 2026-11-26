# Writing style

Use these guidelines for new and edited documentation and TSDoc. They help
readers find an action and understand its outcome.

## Scope

Apply wording changes to prose. Do not rewrite `CHANGELOG.md`, generated
`api-docs/`, or historical records for style. Preserve existing rules and meaning.

## Rules

1. **Do:** Give each sentence one main idea. **Instead of:** Configure the client and upload the file. **Write:** Configure the client. Upload the file.
2. **Do:** Name the actor and use active voice. **Instead of:** The file is uploaded. **Write:** The client uploads the file.
3. **Do:** Use an imperative for a step. **Instead of:** You can select a bucket. **Write:** Select a bucket.
4. **Do:** Use the same term for the same concept. **Instead of:** Upload the object and inspect the item. **Write:** Upload the object and inspect the object.
5. **Do:** Prefer plain verbs. **Instead of:** Initiate the request. **Write:** Start the request.
6. **Do:** Keep articles and clear nouns. **Instead of:** Set option for bucket. **Write:** Set the option for the bucket.
7. **Do:** Remove unnecessary emphasis. **Instead of:** Simply send the request. **Write:** Send the request.
8. **Do:** Make pronouns unambiguous. **Instead of:** The client checks the file before it starts. **Write:** The client checks the file before the upload starts.
9. **Do:** Put the condition before the action. **Instead of:** Retry if the request times out. **Write:** If the request times out, retry.
10. **Do:** Use exact units and values when known. **Instead of:** Wait a few seconds. **Write:** Wait 3 seconds, only when that value is correct.
11. **Do:** Preserve requirement strength. **Instead of:** Change a requirement to advice. **Write:** Keep the meaning of must, should, and can.
12. **Do:** Preserve code, identifiers, flags, error strings, URLs, numbers, and units. **Instead of:** Rename an API for prose. **Write:** Keep the API name unchanged.

## Terms

| Concept | Use |
| --- | --- |
| Stored data | Use **object** for the high-level SDK handle; use **file** for local files and B2 file operations and fields. |
| Credentials | Use **application key** for the credential, **authorization token** for a token, and **SSE-C key** for encryption material. |
| Transfer units | Use **part** for a B2 large-file part and **chunk** for a stream or buffer segment. |
| Container | Use **bucket** for a B2 storage container. |
| Transfers | Use **upload** to send data to B2 and **download** to receive it. |

Check wording against the code and service contract. Preserve security,
compatibility, and error behavior; flag uncertainty instead of guessing.
