// The preload runs in a renderer (DOM + a sandboxed subset of Node), but it is
// typechecked by tsconfig.node.json (lib ES2023 only). Pull in the DOM lib here;
// a dedicated tsconfig.preload.json is proposed in docs/requests/desktop-shell.md.
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
