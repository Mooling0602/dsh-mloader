/**
 * WASM 插件 worker —— **在独立线程里运行外来 wasm 代码**。
 *
 * 为什么必须独立线程：
 *   V8 没有 fuel metering，也没有中断 wasm 执行的 API。一旦 wasm 代码进入死循环，
 *   **任何** JS 代码都不再有机会执行 —— 包括超时定时器。同进程同步调用 wasm
 *   等于把整个 dsh 主线程交给插件摆布。
 *
 *   放进 worker_threads 后，主线程只负责收发消息；超时到了就 worker.terminate()，
 *   那是唯一能真正杀掉死循环的手段。
 *
 * 代价：wasm 插件不能同步回调宿主（host import 跨线程无法同步返回）。
 *      v1 的协议本来就是"apply 返回声明、宿主负责注册"，所以不影响功能。
 */

import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'

let exports_ = null

const REQUIRED_EXPORTS = ['memory', 'dsh_alloc', 'dsh_free', 'dsh_call', 'dsh_result_ptr']

async function init() {
  const bytes = readFileSync(workerData.entry)
  const module = await WebAssembly.compile(bytes)

  const imports = WebAssembly.Module.imports(module)
  const needsWasi = imports.some((entry) => entry.module === 'wasi_snapshot_preview1')

  let importObject = {}
  let wasi = null

  if (needsWasi) {
    const { WASI } = await import('node:wasi')
    // 最小能力：无文件系统、无网络、无环境变量、不能 proc_exit 掉宿主。
    wasi = new WASI({
      version: 'preview1',
      args: [],
      env: {},
      returnOnExit: true,
      preopens: {},
    })
    importObject = { wasi_snapshot_preview1: wasi.wasiImport }
  }

  const instance = await WebAssembly.instantiate(module, importObject)
  exports_ = instance.exports

  const missing = REQUIRED_EXPORTS.filter((name) => !(name in exports_))
  if (missing.length > 0) {
    throw new Error(`wasm module missing required exports: ${missing.join(', ')}`)
  }

  // Go(wasip1) 的 command 模型需要 _start 初始化运行时。
  // 注意：Go 产物在 _start 后会 proc_exit，后续调用属于未定义行为 ——
  // 文档中已标注 Go 不推荐，见 docs/ABI.md。
  if (wasi && typeof exports_._start === 'function') {
    wasi.start(instance)
  }
}

/** 同步调用 wasm，返回原始 JSON 文本。 */
function invoke(op, payload) {
  const request = JSON.stringify({ op, payload })
  const bytes = new TextEncoder().encode(request)

  const reqPtr = exports_.dsh_alloc(bytes.byteLength)
  new Uint8Array(exports_.memory.buffer, reqPtr, bytes.byteLength).set(bytes)

  const resultLen = exports_.dsh_call(reqPtr, bytes.byteLength)

  const resultPtr = exports_.dsh_result_ptr()
  let text = ''
  if (resultLen > 0) {
    const view = new Uint8Array(exports_.memory.buffer, resultPtr, resultLen)
    text = new TextDecoder().decode(view)
  }

  try {
    exports_.dsh_free(reqPtr, bytes.byteLength)
  } catch {
    // 释放失败不影响本次结果
  }

  return text
}

init()
  .then(() => {
    parentPort.on('message', (message) => {
      const { id, op, payload } = message
      try {
        parentPort.postMessage({ id, ok: true, text: invoke(op, payload) })
      } catch (error) {
        parentPort.postMessage({ id, ok: false, error: error.message })
      }
    })
    parentPort.postMessage({ type: 'ready' })
  })
  .catch((error) => {
    parentPort.postMessage({ type: 'init-error', error: error.message })
  })
