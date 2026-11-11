// Types for the Emscripten glue (build.sh): only what src/cbmpc.ts uses.
export interface CbmpcModule {
  ccall(name: string, ret: 'number' | null, args: ('number' | 'string')[], values: (number | string)[], opts?: { async?: boolean }): number | Promise<number>
  HEAPU8: Uint8Array
  _malloc(n: number): number
  _free(p: number): void
  _gz_out_ptr(): number
  _gz_out_size(): number
  _gz_out_clear(): void
  stringToNewUTF8(s: string): number
}
export interface CbmpcOptions {
  instantiateWasm?: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void) => object
  onSend?: (msg: Uint8Array) => void
  onReceive?: () => number | Promise<number>
  takeReceived?: () => Uint8Array
}
export default function createCbmpc(o?: CbmpcOptions): Promise<CbmpcModule>
