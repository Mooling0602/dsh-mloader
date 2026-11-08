# Bundled example sources

This directory holds the example plugins that ship with dsh-mloader.

- `hello-mloader/` is a complete Python plugin. The loader releases it into the profile plugin directory on every start because `seedExamples` is enabled. It registers the `/hello-mloader` and `/hello-add` commands as well as its two tools; `/hello-add` is the command form of the `hello_add` tool, and both commands return multi-line text so the dsh chat card can expand them.
- `wasm-mloader/` is source only. It is a Rust WebAssembly plugin example that registers two tools and two commands, and it is never released automatically: the package does not commit compiled `.wasm` files, and the WebAssembly backend is disabled by default. Build it and install the generated directory yourself.

The release rule in `src/seed.ts` copies only a directory that contains a complete Python manifest and its entry file. Any other directory stays in the package and is skipped.
