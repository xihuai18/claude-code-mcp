# NOTICE

This project (`@leo000001/claude-code-mcp`) is licensed under the MIT License (see `LICENSE`).

## Third-party components

This project depends on third-party packages. Their licenses and terms may impose additional
requirements on redistribution and use.

### Direct dependencies (from `package.json`)

- `@anthropic-ai/claude-agent-sdk@0.2.38` — license is declared as “SEE LICENSE IN README.md” in the package metadata. This package bundles a Claude Code CLI; please review Anthropic's documentation and legal terms referenced by that project before redistributing or deploying.
- `@modelcontextprotocol/sdk@1.26.0` — MIT License
- `zod@4.3.6` — MIT License

For a complete dependency graph, see `package-lock.json`. When installed, each dependency’s
license information is included with the package itself (typically under its `LICENSE` file or
`package.json` fields).

### Optional native dependencies

Some optional dependencies pulled in by the Claude Agent SDK (or its transitive dependencies)
may include prebuilt native binaries with licenses such as LGPL. These packages are platform-
specific (e.g., `@img/sharp-*` and related `libvips` packages).

If you redistribute this project (or produce bundled artifacts), you are responsible for ensuring
you comply with any applicable third-party license obligations and include required notices.
