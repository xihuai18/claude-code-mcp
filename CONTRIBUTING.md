# Contributing

Thanks for your interest in contributing to claude-code-mcp!

## Getting Started

```bash
git clone https://github.com/xihuai18/claude-code-mcp.git
cd claude-code-mcp
npm install
```

### Local Environment Requirements

- Node.js `>=18` (Node 20/22 recommended for local development)
- npm (bundled with Node)
- Windows contributors: install **Git for Windows** (`bash.exe`) for Claude Code CLI compatibility
- Optional: set `CLAUDE_CODE_GIT_BASH_PATH` explicitly when testing MCP clients launched outside your terminal environment

## Development Workflow

1. Create a feature branch from the default branch
2. Make your changes
3. Ensure all checks pass:
   ```bash
   npm run typecheck    # TypeScript type checking
   npm run lint         # ESLint
   npm test             # Vitest
   npm run format:check # Prettier
   ```
4. Commit your changes (pre-commit hooks will run lint-staged + typecheck + test)
5. Open a Pull Request against the default branch

## Code Style

- TypeScript strict mode
- Prettier for formatting (auto-applied via pre-commit hook)
- ESLint for linting
- Prefer explicit types over `any` where possible

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation (README, docs/DESIGN.md) if the public API changes
- Ensure CI passes before requesting review

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include reproduction steps for bugs
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## Release Checklist

1. Update `CHANGELOG.md` with the upcoming version and confirm `package.json` reflects that version.
2. Run `npm run format:check`, `npm run lint`, `npm run typecheck` (now covers `src` + `tests`), and `npm test` to prove the working tree is clean.
3. Build the bundle (`npm run build`) and verify `dist/` contains the expected entry points.
4. Refresh any documentation (README/CONTRIBUTING/docs) that describe public behavior or APIs touched by the release.
5. Ensure `NOTICE.md` lists the third-party components bundled in the release and contains links or pointers to their licenses.
6. Double-check `files`, `bin`, and other package metadata so the published package only ships the intended assets.
