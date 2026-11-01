//! Source-only WebAssembly example plugin for dsh-mloader.
//!
//! The module implements the five core exports documented in
//! `docs/wasm/WasmABI.md` and exchanges JSON through linear memory. It does not
//! import WASI and does not call back into the host.

use std::alloc::{alloc, dealloc, Layout};
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
struct Request {
    op: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Deserialize)]
struct ToolCall {
    tool: String,
    #[serde(default)]
    args: Value,
}

/// Result buffer owned by the plugin and valid until the next request.
static RESULT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// Allocate a request buffer for the host.
#[no_mangle]
pub extern "C" fn dsh_alloc(len: u32) -> u32 {
    if len == 0 {
        return 0;
    }
    let Ok(layout) = Layout::array::<u8>(len as usize) else {
        return 0;
    };
    unsafe { alloc(layout) as u32 }
}

/// Release a request buffer allocated by `dsh_alloc`.
#[no_mangle]
pub extern "C" fn dsh_free(ptr: u32, len: u32) {
    if ptr == 0 || len == 0 {
        return;
    }
    let Ok(layout) = Layout::array::<u8>(len as usize) else {
        return;
    };
    unsafe { dealloc(ptr as *mut u8, layout) }
}

/// Return the pointer of the current result buffer.
#[no_mangle]
pub extern "C" fn dsh_result_ptr() -> u32 {
    let result = RESULT.lock().expect("result mutex poisoned");
    if result.is_empty() {
        0
    } else {
        result.as_ptr() as u32
    }
}

/// Handle one request and return the length of the result buffer.
#[no_mangle]
pub extern "C" fn dsh_call(ptr: u32, len: u32) -> u32 {
    let request = if ptr == 0 || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) }
    };

    let reply = match serde_json::from_slice::<Request>(request) {
        Ok(request) => handle_request(request),
        Err(error) => error_reply(format!("invalid request: {error}")),
    };
    store_reply(reply)
}

fn handle_request(request: Request) -> Value {
    match request.op.as_str() {
        "apply" => declarations(),
        "tool.call" => match serde_json::from_value::<ToolCall>(request.payload) {
            Ok(call) => call_tool(&call),
            Err(error) => error_reply(format!("invalid tool.call payload: {error}")),
        },
        "event" => json!({ "ok": true, "result": null }),
        other => error_reply(format!("unsupported op {other:?}")),
    }
}

fn declarations() -> Value {
    json!({
        "ok": true,
        "result": {
            "tools": [
                {
                    "name": "wasm_add",
                    "description": "Add two numbers (WASM implementation)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "a": { "type": "number" },
                            "b": { "type": "number" }
                        },
                        "required": ["a", "b"],
                        "additionalProperties": false
                    }
                },
                {
                    "name": "wasm_upper",
                    "description": "Upper-case a string (WASM implementation)",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "s": { "type": "string" }
                        },
                        "required": ["s"],
                        "additionalProperties": false
                    }
                }
            ],
            "events": []
        }
    })
}

fn call_tool(call: &ToolCall) -> Value {
    match call.tool.as_str() {
        "wasm_add" => {
            let a = call.args.get("a").and_then(Value::as_f64).unwrap_or(0.0);
            let b = call.args.get("b").and_then(Value::as_f64).unwrap_or(0.0);
            json!({ "ok": true, "result": { "sum": a + b } })
        }
        "wasm_upper" => {
            let text = call.args.get("s").and_then(Value::as_str).unwrap_or("");
            json!({ "ok": true, "result": { "upper": text.to_uppercase() } })
        }
        other => error_reply(format!("unknown tool {other:?}")),
    }
}

fn error_reply(message: String) -> Value {
    json!({ "ok": false, "error": { "message": message } })
}

fn store_reply(reply: Value) -> u32 {
    let bytes = serde_json::to_vec(&reply).unwrap_or_else(|_| {
        b"{\"ok\":false,\"error\":{\"message\":\"reply serialization failed\"}}".to_vec()
    });
    let mut result = RESULT.lock().expect("result mutex poisoned");
    *result = bytes;
    result.len() as u32
}
