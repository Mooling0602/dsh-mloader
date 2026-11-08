// Command wasmcommand is a WebAssembly command fixture. It declares two slash
// command nodes and answers command.call. The hello node returns a normal
// result, and the loop node proves that a command deadline terminates the
// worker.
//
// Build it with:
//
//	GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o command.wasm .
package main

import (
	"encoding/json"
	"strings"
	"unsafe"
)

// reqBuf holds the request the host writes. resBuf holds the result the plugin
// writes and the host reads.
var reqBuf, resBuf []byte

//go:wasmexport mloader_abi_version
func mloaderABIVersion() uint32 { return 1 }

// mloaderAlloc allocates the request buffer and returns its pointer.
//
//go:wasmexport mloader_alloc
func mloaderAlloc(size uint32) uint32 {
	reqBuf = make([]byte, size)
	if size == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&reqBuf[0])))
}

// mloaderFree releases the request buffer.
//
//go:wasmexport mloader_free
func mloaderFree(ptr, size uint32) { reqBuf = nil }

// mloaderResultPtr returns the pointer of the result buffer, or zero when empty.
//
//go:wasmexport mloader_result_ptr
func mloaderResultPtr() uint32 {
	if len(resBuf) == 0 {
		return 0
	}
	return uint32(uintptr(unsafe.Pointer(&resBuf[0])))
}

// writeJSON stores one JSON reply in the result buffer and returns its length.
func writeJSON(v interface{}) uint32 {
	b, _ := json.Marshal(v)
	resBuf = b
	return uint32(len(resBuf))
}

// mloaderCall handles one protocol request and returns the result length.
//
//go:wasmexport mloader_call
func mloaderCall(ptr, length uint32) uint32 {
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
				"tools":  []interface{}{},
				"events": []string{},
				"commands": []map[string]interface{}{
					{
						"id":          "hello",
						"names":       []string{"wasm-command-hello", "wasm-command-hi"},
						"description": "Greet someone from the command line.",
						"input":       map[string]string{"hint": "who"},
					},
					{
						"id":          "loop",
						"names":       []string{"wasm-command-loop"},
						"description": "Infinite loop (fault injection)",
					},
				},
			},
		})

	case "command.call":
		var call struct {
			Command string `json:"command"`
			Input   string `json:"input"`
		}
		json.Unmarshal(req.Payload, &call)
		switch call.Command {
		case "hello":
			input := strings.TrimSpace(call.Input)
			if input == "error" {
				return writeJSON(map[string]interface{}{
					"ok":     true,
					"result": map[string]interface{}{"kind": "error", "text": "wasm command error"},
				})
			}
			return writeJSON(map[string]interface{}{
				"ok":     true,
				"result": map[string]interface{}{"kind": "success", "text": "hello " + input},
			})
		case "loop":
			// The loop only runs on the worker thread, so the host can still
			// enforce the deadline and terminate the worker.
			for {
			}
		}
		return writeJSON(map[string]interface{}{"ok": false, "error": map[string]string{"message": "unsupported command"}})
	}

	return writeJSON(map[string]interface{}{"ok": false, "error": map[string]string{"message": "unsupported op"}})
}

func main() {}
