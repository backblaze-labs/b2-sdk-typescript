const API_BASE = 'http://localhost:3001'

interface UploadUrlResponse {
  uploadUrl: string
  authorizationToken: string
}

interface B2FileResponse {
  fileId: string
  fileName: string
  contentLength: number
  contentType: string
  contentSha1: string
}

interface FileEntry {
  fileName: string
  size: number
  uploadTimestamp: number
  contentType: string
}

const dropZone = document.getElementById('drop-zone') as HTMLDivElement
const fileInput = document.getElementById('file-input') as HTMLInputElement
const status = document.getElementById('status') as HTMLDivElement
const progressBar = document.getElementById('progress-bar') as HTMLDivElement
const progressFill = document.getElementById('progress-fill') as HTMLDivElement
const fileList = document.getElementById('file-list') as HTMLDivElement

function setStatus(msg: string, isError = false) {
  status.textContent = msg
  status.className = `status ${isError ? 'error' : 'success'}`
}

function setProgress(pct: number) {
  progressBar.style.display = 'block'
  progressFill.style.width = `${pct}%`
  progressFill.textContent = `${Math.round(pct)}%`
}

function hideProgress() {
  progressBar.style.display = 'none'
  progressFill.style.width = '0%'
  progressFill.textContent = ''
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

async function computeSha1(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-1', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function encodeFileName(name: string): string {
  const safe = new Set(
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~!$&'()*+,;=:@/".split(''),
  )
  const encoded: string[] = []
  for (const char of name) {
    if (safe.has(char)) {
      encoded.push(char)
    } else {
      const bytes = new TextEncoder().encode(char)
      for (const byte of bytes) {
        encoded.push(`%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
      }
    }
  }
  return encoded.join('')
}

async function uploadFile(file: File) {
  setStatus(`Preparing to upload ${file.name} (${formatSize(file.size)})...`)
  setProgress(0)

  try {
    setProgress(5)
    const urlResp = await fetch(`${API_BASE}/api/upload-url`)
    if (!urlResp.ok) throw new Error('Failed to get upload URL from server')
    const { uploadUrl, authorizationToken } = (await urlResp.json()) as UploadUrlResponse

    setStatus('Computing SHA-1 checksum...')
    setProgress(15)
    const data = await file.arrayBuffer()
    const sha1 = await computeSha1(data)

    setStatus('Uploading to B2...')
    setProgress(30)

    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: authorizationToken,
        'X-Bz-File-Name': encodeFileName(file.name),
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Length': String(file.size),
        'X-Bz-Content-Sha1': sha1,
        'X-Bz-Info-src_last_modified_millis': String(file.lastModified),
      },
      body: data,
    })

    setProgress(90)

    if (!uploadResp.ok) {
      const errorBody = await uploadResp.text()
      throw new Error(`B2 upload failed (${uploadResp.status}): ${errorBody}`)
    }

    const result = (await uploadResp.json()) as B2FileResponse
    setProgress(100)
    setStatus(
      `Uploaded ${result.fileName} (${formatSize(result.contentLength)}, SHA1: ${result.contentSha1})`,
    )

    await refreshFileList()
  } catch (err) {
    setStatus(`Upload failed: ${err instanceof Error ? err.message : String(err)}`, true)
  } finally {
    setTimeout(hideProgress, 2000)
  }
}

async function refreshFileList() {
  try {
    const resp = await fetch(`${API_BASE}/api/list-files`)
    if (!resp.ok) return
    const files = (await resp.json()) as FileEntry[]

    if (files.length === 0) {
      fileList.innerHTML = '<p class="empty">No files in bucket yet.</p>'
      return
    }

    fileList.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>File Name</th>
            <th>Size</th>
            <th>Type</th>
            <th>Uploaded</th>
          </tr>
        </thead>
        <tbody>
          ${files
            .map(
              (f) => `
            <tr>
              <td>${escapeHtml(f.fileName)}</td>
              <td>${formatSize(f.size)}</td>
              <td>${escapeHtml(f.contentType)}</td>
              <td>${new Date(f.uploadTimestamp).toLocaleString()}</td>
            </tr>
          `,
            )
            .join('')}
        </tbody>
      </table>
    `
  } catch {
    // silently ignore list errors
  }
}

function escapeHtml(str: string): string {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

// Drag and drop handlers
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropZone.classList.add('dragover')
})

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover')
})

dropZone.addEventListener('drop', (e) => {
  e.preventDefault()
  dropZone.classList.remove('dragover')
  const files = e.dataTransfer?.files
  if (files && files.length > 0) {
    const first = files[0]
    if (first) uploadFile(first)
  }
})

dropZone.addEventListener('click', () => {
  fileInput.click()
})

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  if (file) uploadFile(file)
  fileInput.value = ''
})

// Load file list on startup
refreshFileList()
