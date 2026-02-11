# Contributing

Thanks for your interest in contributing to claude-code-mcp!

## Getting Started

```bash
git clone https://github.com/xihuai18/claude-code-mcp.git
cd claude-code-mcp
npm install
```

## Development Workflow

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all checks pass:
   ```bash
   npm run typecheck    # TypeScript type checking
   npm run lint         # ESLint
   npm test             # Vitest
   npm run format:check # Prettier
   ```
4. Commit your changes (pre-commit hooks will run lint-staged + typecheck + test)
5. Open a Pull Request against `main`

## Code Style

- TypeScript strict mode
- Prettier for formatting (auto-applied via pre-commit hook)
- ESLint for linting
- Prefer explicit types over `any` where possible

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation (README, DESIGN.md) if the public API changes
- Ensure CI passes before requesting review

## Reporting Issues

- Use GitHub Issues for bug reports and feature requests
- Include reproduction steps for bugs
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)
