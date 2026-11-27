/**
 * Browser-mode setup file (`vitest.browser.config.ts` `setupFiles`): stops the
 * standalone simulator a test file started, once the file is done. A file that
 * never used the simulator costs one no-op command.
 *
 * @packageDocumentation
 */

import { afterAll } from 'vitest'
import { commands } from 'vitest/browser'

afterAll(async () => {
  await commands.b2simRelease()
})
