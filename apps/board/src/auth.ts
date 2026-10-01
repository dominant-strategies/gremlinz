/** Signed-request auth now lives in @gremlins/hatch so runtimes and browsers share it. */
export { AUTH_HEADERS, requestSigningPayload, signRequest, verifySignedRequest, type AuthResult } from '@gremlins/hatch'
