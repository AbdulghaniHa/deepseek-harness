/* v8 ignore file -- Chrome-launched process entry; NativeHost tests cover the bridge. */
/**
 * Chrome-launched native-messaging host entry. Listens on the harness socket
 * and relays JSON-RPC to the extension over stdin/stdout.
 * @module @deepseek-ai/dsh-browser-chrome-extension/host/main
 */

import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { NativeHost } from './bridge.ts'

const socketPath = process.platform === 'win32'
  ? '\\\\.\\pipe\\dsh-browser-host'
  : dshHomePath('browser', 'host.sock')

const host = new NativeHost({
  socketPath,
  stdin: process.stdin,
  stdout: process.stdout,
})
host.start()

const shutdown = (): void => {
  host.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
