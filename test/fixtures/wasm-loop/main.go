// 故障注入：通过 ABI 进入死循环，验证 worker 能被 terminate。
package main

import (
	"encoding/json"
	"unsafe"
)

var reqBuf, resBuf []byte

//go:wasmexport dsh_alloc
func dshAlloc(size uint32) uint32 {
	reqBuf = make([]byte, size)
	if size == 0 { return 0 }
	return uint32(uintptr(unsafe.Pointer(&reqBuf[0])))
}

//go:wasmexport dsh_free
func dshFree(ptr, size uint32) { reqBuf = nil }

//go:wasmexport dsh_result_ptr
func dshResultPtr() uint32 {
	if len(resBuf) == 0 { return 0 }
	return uint32(uintptr(unsafe.Pointer(&resBuf[0])))
}

func writeJSON(v interface{}) uint32 {
	b, _ := json.Marshal(v)
	resBuf = b
	return uint32(len(resBuf))
}

//go:wasmexport dsh_call
func dshCall(ptr, length uint32) uint32 {
	raw := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
	var req struct {
		Op      string          `json:"op"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return writeJSON(map[string]interface{}{"ok": false, "error": map[string]string{"message": err.Error()}})
	}

	switch req.Op {
	case "apply":
		return writeJSON(map[string]interface{}{
			"ok": true,
			"result": map[string]interface{}{
				"tools": []map[string]interface{}{
					{"name": "wasm_loop_forever", "description": "无限循环（故障注入）",
						"parameters": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
					{"name": "wasm_fine", "description": "正常工具",
						"parameters": map[string]interface{}{"type": "object", "properties": map[string]interface{}{}}},
				},
				"events": []string{},
			},
		})

	case "tool.call":
		var call struct {
			Tool string                 `json:"tool"`
			Args map[string]interface{} `json:"args"`
		}
		json.Unmarshal(req.Payload, &call)
		if call.Tool == "wasm_loop_forever" {
			// ★ 故意死循环：主线程若同步调用，dsh 会永久卡死
			for {
			}
		}
		return writeJSON(map[string]interface{}{"ok": true, "result": map[string]interface{}{"fine": true}})
	}

	return writeJSON(map[string]interface{}{"ok": false, "error": map[string]string{"message": "unsupported op"}})
}

func main() {}
