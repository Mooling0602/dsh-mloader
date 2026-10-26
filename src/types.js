/**
 * Structural types for the loader and the runtimes it hosts.
 *
 * The loader lives in two worlds at once: it is an ordinary Cordis plugin, and
 * it is the host of plugins that are not Cordis plugins. This module declares
 * only the host surface the loader relies on and the shapes that cross the
 * plugin boundary. The declarations are structural so the package keeps no
 * dependency on the Cordis packages.
 *
 * @module types
 */
export {};
