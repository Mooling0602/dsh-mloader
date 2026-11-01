# wasm-mloader

A source-only Rust WebAssembly example plugin for dsh-mloader.

The loader does not install this directory. The package intentionally does not contain a compiled `.wasm` artifact, and the WebAssembly backend is disabled by default. Build the example, then copy the generated directory into the profile plugin root and enable the backend.

## Requirements

- Rust with the `wasm32-unknown-unknown` target and a working wasm linker.
- The build script uses `cargo`; install the target with `rustup target add wasm32-unknown-unknown` if it is missing.

## Build

Run the script from this directory:

```sh
./build.sh
```

The output is written to `dist/wasm-mloader/` and contains `mloader.plugin.json` and `wasm_mloader.wasm`. Pass a different output directory as the first argument when building outside this checkout.

## Install

Enable the backend in the profile configuration, then copy the generated directory into the profile plugin root:

```sh
mkdir -p ~/.dsh/profiles/web/mloader/plugins
cp -r dist/wasm-mloader ~/.dsh/profiles/web/mloader/plugins/
```

The loader watches the plugin root and mounts the directory. If watching is disabled, load it with `/mloader load wasm-mloader`.

## What the example demonstrates

- The core WebAssembly ABI exports: `memory`, `mloader_alloc`, `mloader_free`, `mloader_call`, `mloader_result_ptr` and `mloader_abi_version`.
- The declaration and JSON request contract for `apply`, `tool.call` and `event`.
- Two tools, `wasm_add` and `wasm_upper`.

The WebAssembly backend has no logging, effect or synchronous host-call channel, so the example does not pretend to have one.
