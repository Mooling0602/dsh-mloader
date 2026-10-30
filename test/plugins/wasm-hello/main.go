// Command wasmhello is an example WebAssembly plugin written in Go and compiled
// for wasip1.
//
// The ABI is specified in docs/wasm/WasmABI.md: the host exchanges JSON through
// dsh_alloc, dsh_call and dsh_result_ptr. This file depends only on the Go
// standard library.
package main

import (
	"encoding/json"
	"unsafe"
)

// reqBuf holds the request the host writes. resBuf holds the result the plugin
// writes and the host reads.
var (
	reqBuf []byte
	resBuf []byte
)

// dshAlloc allocates the request buffer and returns its pointer.
//
//go:wasmexport dsh_alloc
func dshAlloc(size uint32) uint32 {
	reqBuf = make([]byte, size)
	if size == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&reqBuf[0])))
}

// dshFree releases the request buffer.
//
//go:wasmexport dsh_free
func dshFree(ptr uint32, size uint32) {
	reqBuf = nil
}

// dshResultPtr returns the pointer of the result buffer, or zero when empty.
//
//go:wasmexport dsh_result_ptr
func dshResultPtr() uint32 {
	if len(resBuf) == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&resBuf[0])))
}

// request is one protocol request.
type request struct {
	Op      string          `json:"op"`
	Payload json.RawMessage `json:"payload"`
}

// response is one protocol reply.
type response struct {
	OK     bool        `json:"ok"`
	Result interface{} `json:"result,omitempty"`
	Error  *respError  `json:"error,omitempty"`
}

// respError is the error object of a failed reply.
type respError struct {
	Message string `json:"message"`
}

// toolCall is the payload of a tool.call request.
type toolCall struct {
	Tool string                 `json:"tool"`
	Args map[string]interface{} `json:"args"`
}

// toolSpec is one tool declaration.
type toolSpec struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Parameters  map[string]interface{} `json:"parameters"`
}

// applyResult is the declaration a plugin returns in reply to apply. The host
// performs the registrations itself, so no host import is needed.
type applyResult struct {
	Tools  []toolSpec `json:"tools"`
	Events []string   `json:"events"`
}

var registeredTools []toolSpec

// dshCall handles one protocol request and returns the result length.
//
//go:wasmexport dsh_call
func dshCall(ptr uint32, length uint32) uint32 {
	raw := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
	var req request
	if err := json.Unmarshal(raw, &req); err != nil {
		return writeResponse(response{OK: false, Error: &respError{Message: err.Error()}})
	}

	switch req.Op {
	case "apply":
		registeredTools = []toolSpec{
			{
				Name:        "wasm_add",
				Description: "Add two numbers (WASM implementation)",
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
				Description: "Upper-case a string (WASM implementation)",
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

// callTool dispatches one tool call to its implementation.
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

// writeResponse stores one reply in the result buffer and returns its length.
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
