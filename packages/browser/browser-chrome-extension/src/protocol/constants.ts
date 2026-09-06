/**
 * Fixed protocol constants for the Chrome native-messaging and socket bridge.
 * @module @deepseek-ai/dsh-browser-chrome-extension/protocol/constants
 */

/** Native-messaging host name written into Chrome host manifests. */
export const NATIVE_HOST_NAME = 'com.deepseek.dsh.browser'

/** JSON-RPC protocol version; a mismatch fails loud. */
export const PROTOCOL_VERSION = 1

/** Chrome native-messaging maximum payload size (host → extension). */
export const MAX_NATIVE_MESSAGE_BYTES = 1_048_576

/** Length prefix is a 4-byte little-endian unsigned integer. */
export const FRAME_HEADER_BYTES = 4
