# AGENTS.ignore.md

## Loader changes for one external plugin

**Wrong route.** Adding a loader interface, API, SDK entry, configuration key, install rule or backend behaviour for the convenience of one particular external plugin, and keeping a plugin specific verification harness in this repository. A harness for dsh-credentials-helper was placed under .build this way. The loader hosts every external plugin through one contract, so a special case for one plugin turns that contract into an exception every later change has to preserve, and plugin specific material in this repository makes the two projects depend on each other's layout.

**Settled decision.** The loader's interfaces, APIs and SDKs serve all external plugins. It is settled that no loader change is made for one specific plugin, that the loader is never patched or extended to make a particular plugin work, and that a plugin's verification harness lives in that plugin's repository and treats the loader as an external dependency. Generality, standardization and maintainability take priority. A plugin that needs a capability the loader does not provide solves it inside the plugin, or does without it.
