/**
 * Minimal React Native screen that picks an image and uploads it to B2 via
 * the presigned-URL backend in `../backend/server.ts`.
 *
 * Uses `expo-image-picker` for the file picker. If you're on bare React
 * Native, swap in `react-native-image-picker`: the rest of the code is the
 * same.
 */

import * as ImagePicker from 'expo-image-picker'
import { useState } from 'react'
import { Button, StyleSheet, Text, View } from 'react-native'
import { uploadToBackblaze } from './upload'

// Point this at your backend's `/sign` route.
const SIGN_ENDPOINT = 'https://your-api.example.com/sign'

export default function App() {
  const [status, setStatus] = useState<string>('Tap to pick a photo')
  const [busy, setBusy] = useState(false)

  async function onPick() {
    setBusy(true)
    setStatus('Selecting…')
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 1,
      })
      if (result.canceled) {
        setStatus('Cancelled')
        return
      }
      const asset = result.assets[0]
      if (!asset) throw new Error('no asset')
      // expo-image-picker gives us a URI; fetch it to get a Blob.
      const blob = await fetch(asset.uri).then((r) => r.blob())

      setStatus(`Uploading ${blob.size} bytes…`)
      const upload = await uploadToBackblaze({
        signEndpoint: SIGN_ENDPOINT,
        fileName: `photos/${Date.now()}.jpg`,
        blob,
      })
      setStatus(`✓ uploaded ${upload.fileName} (${upload.fileId})`)
    } catch (err) {
      setStatus(`✗ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.status}>{status}</Text>
      <Button title="Pick a photo" onPress={onPick} disabled={busy} />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  status: { fontSize: 16, textAlign: 'center' },
})
