// 示例 WASM 插件 —— 用 Go 写，编译到 wasip1。
//
// ABI 见 docs/ABI.md §7：core-wasm，宿主通过 dsh_alloc/dsh_call/dsh_result_ptr
// 交换 JSON。这个文件只依赖 Go 标准库的 unsafe，不依赖任何第三方包。

package main

import (
	"encoding/json"
	"unsafe"
)

// ── 线性内存管理 ──────────────────────────────────────────────────────────

var (
	// 请求缓冲区：宿主写入 JSON 请求
	reqBuf []byte
	// 结果缓冲区：插件写入 JSON 结果，宿主读取
	resBuf []byte
)

//go:wasmexport dsh_alloc
func dshAlloc(size uint32) uint32 {
	reqBuf = make([]byte, size)
	if size == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&reqBuf[0])))
}

//go:wasmexport dsh_free
func dshFree(ptr uint32, size uint32) {
	reqBuf = nil
}

//go:wasmexport dsh_result_ptr
func dshResultPtr() uint32 {
	if len(resBuf) == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&resBuf[0])))
}

// ── 协议 ──────────────────────────────────────────────────────────────────

type request struct {
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}

type response struct {
	OK     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  *respError  `json:"error,omitempty"`
}

type respError struct {
	Message string `json:"message"`
}

type toolCall struct {
	Tool string                 `json:"tool"`
	Args map[string]interface{} `json:"args"`
}

type registerPayload struct {
	Tool toolSpec `json:"tool"`
}

type toolSpec struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Parameters  map[string]interface{} `json:"parameters"`
}

// 宿主回调：注册工具（由 loader 通过 host import 处理）
// 简化做法：把注册意图放进结果里返回，由宿主解析。

type applyResult struct {
	Tools  []toolSpec `json:"tools"`
	Events []string   `json:"events"`
}

var registeredTools []toolSpec

//go:wasmexport dsh_call
func dshCall(ptr uint32, length uint32) uint32 {
	raw := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		return writeResponse(response{OK: false, Error: &respError{Message: err.Error()}})
	}

	switch req.Op {
	case "apply":
		// 声明本插件的工具
		registeredTools = []toolSpec{
			{
				Name:        "wasm_add",
				Description: "两数相加（WASM 实现）",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"a": map[string]interface{}{"type": "number"},
						"b": map[string]interface{}{"type": "number"},
					},
					"required": []string{"a", "b"},
				},
			},
			{
				Name:        "wasm_upper",
				Description: "把字符串转成大写（WASM 实现）",
				Parameters: map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"s": map[string]interface{}{"type": "string"},
					},
					"required": []string{"s"},
				},
			},
		}
		return writeResponse(response{OK: true, Result: applyResult{Tools: registeredTools, Events: []string{}}})

	case "tool.call":
		var call toolCall
		if err := json.Unmarshal(req.Payload, &call); err != nil {
			return writeResponse(response{OK: false, Error: &respError{Message: err.Error()}})
		}
		return writeResponse(callTool(call.Tool, call.Args))

	default:
		return writeResponse(response{OK: false, Error: &respError{Message: "unsupported op " + req.Op}})
	}
}

func callTool(name string, args map[string]interface{}) response {
	switch name {
	case "wasm_add":
		a, _ := args["a"].(float64)
		b, _ := args["b"].(float64)
		return response{OK: true, Result: map[string]interface{}{"sum": a + b}}

	case "wasm_upper":
		s, _ := args["s"].(string)
		runes := []rune(s)
		for i, r := range runes {
			if r >= 'a' && r <= 'z' {
				runes[i] = r - 32
			}
		}
		return response{OK: true, Result: map[string]interface{}{"upper": string(runes)}}

	default:
		return response{OK: false, Error: &respError{Message: "unknown tool " + name}}
	}
}

func writeResponse(resp response) uint32 {
	data, err := json.Marshal(resp)
	if err != nil {
		resBuf = []byte(`{"ok":false,"error":{"message":"marshal failed"}}`)
		return uint32(len(resBuf))
	}
	resBuf = data
	return uint32(len(resBuf))
}

func main() {}
